import { Inject, Injectable } from '@nestjs/common';
import {
  EventBus,
  ID,
  idsAreEqual,
  Logger,
  Order,
  OrderModification,
  Refund,
  RequestContext,
  TransactionalConnection,
  UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';

import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import {
  buildCreditNote,
  checkModel,
  CreditableSummary,
  creditableSummary,
  CreditNoteError,
  CreditNoteRequest,
  EInvoiceModel,
  InvoiceIssue,
  Money,
  sum,
  toCii,
} from '../core';
import { EInvoice, EInvoiceReason } from '../entities';
import { EInvoiceBlockedEvent } from '../events';
import { mappingLabels } from '../mapping/labels';
import { OrderModelMapper } from '../mapping/order-model.mapper';
import { ResolvedEInvoicePluginOptions } from '../options';

import { InvoiceNumberService } from './invoice-number.service';

/** Documents that count: they have a number (a BLOCKED one has none, a VOID one was never rendered). */
export const NUMBERED_STATUSES = ['PENDING', 'ISSUED', 'FAILED'] as const;

export interface CreditOptions {
  reason: EInvoiceReason;
  /** Offset against a new invoice instead of refunded (cancel and reissue) */
  settlement?: 'refund' | 'offset';
  refundId?: ID;
}

/**
 * Credit notes (type 381). They are always built from the snapshot of the corrected invoice, never from the
 * current order. All methods that write must run inside a transaction with the order row locked, so the
 * remaining amount of an invoice cannot be credited twice by concurrent requests.
 */
@Injectable()
export class CreditNoteService {
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private eventBus: EventBus,
    private mapper: OrderModelMapper,
    private numbers: InvoiceNumberService,
  ) {}

  creditNotesOf(ctx: RequestContext, invoiceId: ID): Promise<EInvoice[]> {
    return this.connection.getRepository(ctx, EInvoice).find({
      where: { correctedInvoiceId: invoiceId, type: 'credit_note', status: In([...NUMBERED_STATUSES]) },
      relations: ['files'],
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /** Invoice total minus its credit notes (gross). */
  async remainingAmount(ctx: RequestContext, invoice: EInvoice): Promise<Money> {
    if (invoice.type !== 'invoice') return 0;
    const notes = await this.creditNotesOf(ctx, invoice.id);
    return invoice.totalWithTax - sum(notes.map((n) => n.totalWithTax));
  }

  /**
   * Creates a credit note for `invoice` (PENDING, rendered after commit). Throws a `UserInputError` if the
   * request cannot be fulfilled or the result does not pass the checks.
   */
  async credit(ctx: RequestContext, invoice: EInvoice, request: CreditNoteRequest, options: CreditOptions): Promise<EInvoice> {
    const result = await this.build(ctx, invoice, request, options);
    if ('issues' in result) throw new UserInputError(result.issues.map((i) => i.message).join('; '));
    return this.saveNumbered(ctx, invoice, result.model, options);
  }

  /**
   * Credit note for a settled Vendure refund. Idempotent per refund. Skips refunds of order modifications
   * (those are handled as cancel and reissue), orders without an invoice, and invoices that are already fully
   * credited (e.g. by the cancellation credit note). Problems produce a BLOCKED credit note that can be retried.
   */
  async creditRefund(ctx: RequestContext, refundId: ID): Promise<EInvoice | undefined> {
    const refund = await this.connection
      .getRepository(ctx, Refund)
      .findOne({ where: { id: refundId }, relations: ['lines', 'payment', 'payment.order'] });
    if (!refund) throw new Error(`Refund ${refundId} not found`);
    const orderId = refund.payment.order.id;
    const repo = this.connection.getRepository(ctx, EInvoice);
    const existing = await repo.findOne({ where: { refundId: String(refundId) } });
    if (existing && existing.status !== 'BLOCKED') return undefined;
    const skip = async (why: string) => {
      Logger.verbose(`No credit note for refund ${refundId}: ${why}`, loggerCtx);
      if (existing) await repo.remove(existing);
      return undefined;
    };

    const modification = await this.connection.getRepository(ctx, OrderModification).findOne({ where: { refund: { id: refundId } } });
    if (modification) return skip('it belongs to an order modification (handled by cancel and reissue)');

    const invoice = await this.latestInvoice(ctx, orderId);
    if (!invoice) return skip('the order has no invoice');
    if ((await this.remainingAmount(ctx, invoice)) <= 0) return skip(`invoice ${invoice.number} is already fully credited`);

    const options: CreditOptions = { reason: 'refund', refundId };
    const result = await this.build(ctx, invoice, await this.refundRequest(ctx, invoice, refund), options);
    if ('issues' in result) {
      const blocked = existing ?? new EInvoice({ channelId: ctx.channelId, orderId, type: 'credit_note', reason: 'refund', files: [] });
      Object.assign(blocked, {
        status: 'BLOCKED',
        correctedInvoiceId: invoice.id,
        refundId: String(refundId),
        currencyCode: invoice.currencyCode,
        totalNet: result.model?.totals?.taxBasisTotal ?? 0,
        totalTax: result.model?.totals?.taxTotal ?? 0,
        totalWithTax: refund.total,
        formats: invoice.formats,
        model: result.model ?? null,
        issues: result.issues,
      });
      const saved = await repo.save(blocked);
      Logger.warn(`Credit note for refund ${refundId} is blocked: ${result.issues.map((i) => i.message).join('; ')}`, loggerCtx);
      await this.eventBus.publish(new EInvoiceBlockedEvent(ctx, saved, result.issues));
      return saved;
    }
    return this.saveNumbered(ctx, invoice, result.model, options, existing ?? undefined);
  }

  /** The latest numbered invoice of the order (after a reissue, the older ones are fully credited). */
  latestInvoice(ctx: RequestContext, orderId: ID): Promise<EInvoice | null> {
    return this.connection.getRepository(ctx, EInvoice).findOne({
      where: { orderId, type: 'invoice', status: In([...NUMBERED_STATUSES]) },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  /**
   * Vendure ≥ 2.2 refunds carry only an amount by default; that amount is split across the VAT rates.
   * Refunds created with the deprecated `lines` / `shipping` input credit those lines and the shipping, and any
   * difference to the refunded amount (adjustment, rounding) is credited or deducted as an amount.
   */
  private async refundRequest(ctx: RequestContext, invoice: EInvoice, refund: Refund): Promise<CreditNoteRequest> {
    const model = invoice.model as EInvoiceModel;
    const lines = (refund.lines ?? [])
      .filter((rl) => rl.quantity > 0)
      .flatMap((rl) => {
        const line = model.lines.find((l) => l.orderLineId !== undefined && idsAreEqual(l.orderLineId, rl.orderLineId));
        return line ? [{ lineId: line.id, quantity: String(rl.quantity) }] : [];
      });
    const base: CreditNoteRequest = { lines, charges: refund.shipping > 0 };
    if (!lines.length && !base.charges) return { amount: refund.total };
    try {
      const draft = this.buildModel(ctx, invoice, await this.previousModels(ctx, invoice), base, {});
      const credited = (draft.totals?.grandTotal ?? 0) + (draft.totals?.roundingAmount ?? 0);
      return { ...base, amount: refund.total - credited };
    } catch (e) {
      if (e instanceof CreditNoteError) return { amount: refund.total };
      throw e;
    }
  }

  private async build(
    ctx: RequestContext,
    invoice: EInvoice,
    request: CreditNoteRequest,
    options: CreditOptions,
  ): Promise<{ model: EInvoiceModel } | { model?: EInvoiceModel; issues: InvoiceIssue[] }> {
    if (invoice.type !== 'invoice' || !invoice.model || !invoice.number) {
      return { issues: [{ code: 'NOT_AN_INVOICE', message: `E-invoice ${invoice.id} is not a numbered invoice` }] };
    }
    let model: EInvoiceModel;
    try {
      model = this.buildModel(ctx, invoice, await this.previousModels(ctx, invoice), request, options);
    } catch (e) {
      if (e instanceof CreditNoteError) return { issues: [{ code: e.code, message: e.message }] };
      throw e;
    }
    const issues = checkModel(model, invoice.formats);
    return issues.length ? { model, issues } : { model };
  }

  private buildModel(
    ctx: RequestContext,
    invoice: EInvoice,
    previous: EInvoiceModel[],
    request: CreditNoteRequest,
    options: Pick<CreditOptions, 'settlement'>,
  ): EInvoiceModel {
    const model = invoice.model as EInvoiceModel;
    const allocation = this.options.mapping.creditAllocation;
    return buildCreditNote(model, previous, request, {
      issueDate: this.mapper.today(),
      texts: mappingLabels(model.language).creditNote,
      allocate: allocation ? (input) => allocation(ctx, input) : undefined,
      fallbackThreshold: this.options.roundingFallbackThreshold,
      settlement: options.settlement,
    });
  }

  /** What of an invoice can still be credited; `undefined` for credit notes and documents without snapshot. */
  async creditable(ctx: RequestContext, invoice: EInvoice): Promise<CreditableSummary | undefined> {
    if (invoice.type !== 'invoice' || !invoice.model || !invoice.number) return undefined;
    return creditableSummary(invoice.model, await this.previousModels(ctx, invoice));
  }

  private async previousModels(ctx: RequestContext, invoice: EInvoice): Promise<EInvoiceModel[]> {
    return (await this.creditNotesOf(ctx, invoice.id)).map((n) => n.model as EInvoiceModel);
  }

  private async saveNumbered(
    ctx: RequestContext,
    invoice: EInvoice,
    model: EInvoiceModel,
    options: CreditOptions,
    existing?: EInvoice,
  ): Promise<EInvoice> {
    const order = await this.connection.getRepository(ctx, Order).findOneOrFail({ where: { id: invoice.orderId } });
    const reserved = await this.numbers.reserve(ctx, { type: 'credit_note', order, issueDate: model.issueDate });
    model.number = reserved.number;
    // Fail fast: a serializer error rolls back the transaction, so no number is consumed
    toCii(model, 'zugferd');
    const totals = model.totals!;
    const note = existing ?? new EInvoice({ channelId: ctx.channelId, orderId: invoice.orderId, type: 'credit_note', files: [] });
    Object.assign(note, {
      status: 'PENDING',
      reason: options.reason,
      number: reserved.number,
      sequenceKey: reserved.key,
      sequenceValue: reserved.value,
      issueDate: model.issueDate,
      currencyCode: model.currencyCode,
      totalNet: totals.taxBasisTotal,
      totalTax: totals.taxTotal,
      totalWithTax: totals.grandTotal + totals.roundingAmount,
      formats: invoice.formats,
      model,
      correctedInvoiceId: invoice.id,
      refundId: options.refundId !== undefined ? String(options.refundId) : null,
      issues: null,
      errorMessage: null,
    });
    const saved = await this.connection.getRepository(ctx, EInvoice).save(note);
    Logger.info(`Credit note ${saved.number} for invoice ${invoice.number} (${options.reason})`, loggerCtx);
    return saved;
  }
}
