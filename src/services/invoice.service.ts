import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
  EventBus,
  ID,
  idsAreEqual,
  JobQueue,
  JobQueueService,
  ListQueryBuilder,
  ListQueryOptions,
  Logger,
  PaginatedList,
  OrderStateTransitionEvent,
  Refund,
  RefundStateTransitionEvent,
  RequestContext,
  SerializedRequestContext,
  TransactionalConnection,
  UserInputError,
} from '@vendure/core';

import { E_INVOICE_QUEUE, loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { calculate, checkModel, CreditNoteRequest, pdfLabels, toCii } from '../core';
import { EInvoice, EInvoiceReason } from '../entities';
import { EInvoiceBlockedEvent } from '../events';
import { OrderModelMapper, orderFingerprint } from '../mapping/order-model.mapper';
import { ResolvedEInvoicePluginOptions } from '../options';

import { ChannelSettingsService, SetupIssue } from './channel-settings.service';
import { CreditNoteService, NUMBERED_STATUSES } from './credit-note.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoiceRenderService } from './invoice-render.service';
import { lockOrder } from './order-lock';

type JobData =
  | { type: 'reconcile'; orderId: ID; ctx: SerializedRequestContext }
  | { type: 'credit-refund'; refundId: ID; ctx: SerializedRequestContext }
  | { type: 'render'; invoiceId: ID; ctx: SerializedRequestContext };

/** While an order is in one of these states, its amounts are not final yet. */
const UNSETTLED_STATES = ['Modifying', 'ArrangingAdditionalPayment', 'ArrangingPayment', 'AddingItems', 'Draft'];

export interface ManualCreditNoteInput {
  invoiceId: ID;
  /** Order lines and quantities to credit */
  lines?: { orderLineId: ID; quantity: number }[];
  /** Credit shipping and surcharges */
  shipping?: boolean;
  /** Additional gross amount; negative = deduction */
  amount?: number;
  /** Credit everything that has not been credited yet */
  fullReversal?: boolean;
  /** Printed on the credit note */
  note?: string;
}

@Injectable()
export class InvoiceService implements OnApplicationBootstrap {
  private queue: JobQueue<JobData>;

  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private jobQueueService: JobQueueService,
    private eventBus: EventBus,
    private mapper: OrderModelMapper,
    private numbers: InvoiceNumberService,
    private settings: ChannelSettingsService,
    private renderer: InvoiceRenderService,
    private creditNotes: CreditNoteService,
    private listQueryBuilder: ListQueryBuilder,
  ) {}

  async onApplicationBootstrap() {
    this.queue = await this.jobQueueService.createQueue<JobData>({
      name: E_INVOICE_QUEUE,
      process: async (job) => {
        const ctx = RequestContext.deserialize(job.data.ctx);
        switch (job.data.type) {
          case 'reconcile':
            return void (await this.reconcile(ctx, job.data.orderId));
          case 'credit-refund':
            return void (await this.creditRefund(ctx, job.data.refundId));
          case 'render':
            return void (await this.renderer.render(ctx, job.data.invoiceId));
        }
      },
    });

    this.eventBus.ofType(OrderStateTransitionEvent).subscribe((event) => {
      if (
        this.options.issueOnStates.includes(event.toState) ||
        event.toState === 'Cancelled' ||
        event.fromState === 'Modifying' ||
        event.fromState === 'ArrangingAdditionalPayment'
      ) {
        this.enqueue({ type: 'reconcile', orderId: event.order.id, ctx: event.ctx.serialize() });
      }
    });
    this.eventBus.ofType(RefundStateTransitionEvent).subscribe((event) => {
      if (event.toState === 'Settled' && this.options.autoCreditNotes) {
        this.enqueue({ type: 'credit-refund', refundId: event.refund.id, ctx: event.ctx.serialize() });
      }
    });
  }

  findOne(ctx: RequestContext, id: ID): Promise<EInvoice | null> {
    return this.connection.getRepository(ctx, EInvoice).findOne({
      where: { id, channelId: ctx.channelId },
      relations: ['files'],
    });
  }

  /** Invoices and credit notes of the current channel. `orderCode` filters and sorts by the order code. */
  async findAll(ctx: RequestContext, options?: ListQueryOptions<EInvoice>): Promise<PaginatedList<EInvoice>> {
    const [items, totalItems] = await this.listQueryBuilder
      .build(EInvoice, options, {
        ctx,
        relations: ['files', 'order'],
        where: { channelId: ctx.channelId },
        customPropertyMap: { orderCode: 'order.code' },
        orderBy: { createdAt: 'DESC', id: 'DESC' },
      })
      .getManyAndCount();
    return { items, totalItems };
  }

  findByOrder(ctx: RequestContext, orderId: ID): Promise<EInvoice[]> {
    return this.connection.getRepository(ctx, EInvoice).find({
      where: { orderId, channelId: ctx.channelId },
      relations: ['files'],
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * Manual creation (admin). The checks run synchronously, so problems are returned immediately
   * as a BLOCKED invoice with `issues`; the files are rendered in the background.
   */
  async create(ctx: RequestContext, orderId: ID): Promise<EInvoice> {
    const invoice = await this.connection.withTransaction(ctx, async (txCtx) => {
      const order = await lockOrder(this.connection, txCtx, orderId);
      if (!order) throw new UserInputError(`Order ${orderId} not found`);
      const open = await this.openInvoice(txCtx, orderId);
      if (open) throw new UserInputError(`Order ${order.code} already has invoice ${open.number}`);
      return this.issue(txCtx, orderId, 'manual');
    });
    await this.afterIssue(ctx, [invoice]);
    return invoice;
  }

  /** Manual credit note (admin): lines, shipping, an amount, or a full reversal. */
  async createCreditNote(ctx: RequestContext, input: ManualCreditNoteInput): Promise<EInvoice> {
    const note = await this.connection.withTransaction(ctx, async (txCtx) => {
      const invoice = await this.lockedInvoice(txCtx, input.invoiceId);
      const model = invoice.model;
      const request: CreditNoteRequest = {
        full: input.fullReversal ?? false,
        charges: input.shipping ?? false,
        amount: input.amount ?? 0,
        note: input.note,
        lines: (input.lines ?? []).map((l) => {
          const line = model?.lines.find((x) => x.orderLineId !== undefined && idsAreEqual(x.orderLineId, l.orderLineId));
          if (!line) throw new UserInputError(`Order line ${l.orderLineId} is not part of invoice ${invoice.number}`);
          return { lineId: line.id, quantity: String(l.quantity) };
        }),
      };
      return this.creditNotes.credit(txCtx, invoice, request, { reason: 'manual' });
    });
    await this.afterIssue(ctx, [note]);
    return note;
  }

  /**
   * Full credit note for the invoice plus a new invoice for the current order (e.g. after the buyer data was
   * corrected). Returns the new invoice, which can be BLOCKED if the checks fail.
   */
  async cancelAndReissue(ctx: RequestContext, invoiceId: ID): Promise<EInvoice> {
    const docs = await this.connection.withTransaction(ctx, async (txCtx) => {
      const original = await this.lockedInvoice(txCtx, invoiceId);
      const latest = await this.creditNotes.latestInvoice(txCtx, original.orderId);
      if (latest && !idsAreEqual(latest.id, original.id)) {
        throw new UserInputError(`Invoice ${original.number} has been replaced by ${latest.number}`);
      }
      const note = await this.creditNotes.credit(txCtx, original, { full: true }, { reason: 'manual', settlement: 'offset' });
      return [note, await this.issue(txCtx, original.orderId, 'manual')];
    });
    await this.afterIssue(ctx, docs);
    return docs[1];
  }

  /**
   * BLOCKED invoice: map the order again (the cause may be fixed). BLOCKED credit note: build it from the refund
   * again. FAILED: render again from the snapshot.
   */
  async retry(ctx: RequestContext, id: ID): Promise<EInvoice | undefined> {
    const existing = await this.findOne(ctx, id);
    if (!existing) throw new UserInputError(`E-invoice ${id} not found`);
    if (existing.status === 'FAILED') {
      await this.enqueue({ type: 'render', invoiceId: existing.id, ctx: ctx.serialize() });
      return existing;
    }
    if (existing.status !== 'BLOCKED') throw new UserInputError(`E-invoice ${id} is ${existing.status} and cannot be retried`);
    if (existing.type === 'credit_note') {
      if (!existing.refundId) throw new UserInputError(`Credit note ${id} has no refund to retry`);
      return this.creditRefund(ctx, existing.refundId);
    }
    const invoice = await this.connection.withTransaction(ctx, async (txCtx) => {
      await lockOrder(this.connection, txCtx, existing.orderId);
      return this.issue(txCtx, existing.orderId, existing.reason);
    });
    await this.afterIssue(ctx, [invoice]);
    return invoice;
  }

  /**
   * A FAILED document that can never be rendered. Its number stays used; the reason documents the gap
   * in the number sequence.
   */
  async void(ctx: RequestContext, id: ID, reason: string): Promise<EInvoice> {
    if (!reason?.trim()) throw new UserInputError('A reason is required to void an e-invoice');
    return this.connection.withTransaction(ctx, async (txCtx) => {
      const invoice = await this.findOne(txCtx, id);
      if (!invoice) throw new UserInputError(`E-invoice ${id} not found`);
      await lockOrder(this.connection, txCtx, invoice.orderId);
      const current = await this.findOne(txCtx, id);
      if (current?.status !== 'FAILED') {
        throw new UserInputError(`E-invoice ${invoice.number ?? id} is ${current?.status} and cannot be voided (only FAILED)`);
      }
      Object.assign(current, { status: 'VOID', voidReason: reason.trim() });
      const saved = await this.connection.getRepository(txCtx, EInvoice).save(current);
      Logger.warn(`E-invoice ${saved.number} voided`, loggerCtx);
      return saved;
    });
  }

  /**
   * Renders the invoice the order would get now, with a draft number. Nothing is saved and no number is used.
   * Returns the problems that would block the invoice; the PDF is rendered anyway if possible.
   */
  async preview(ctx: RequestContext, orderId: ID): Promise<{ pdf: string | null; issues: SetupIssue[] }> {
    const order = await this.mapper.loadOrder(ctx, orderId);
    if (!order) throw new UserInputError(`Order ${orderId} not found`);
    const mapped = await this.mapper.toModel(ctx, order);
    if (!mapped) {
      return { pdf: null, issues: [{ code: 'SELLER_INCOMPLETE', message: 'E-invoicing is not set up for this channel (no seller data)' }] };
    }
    const { model, formats } = mapped;
    model.totals = calculate(model, {
      expectedTotalWithTax: order.totalWithTax,
      fallbackThreshold: this.options.roundingFallbackThreshold,
    });
    model.number = pdfLabels(model.language, this.options.pdf.translations).draft;
    if (model.totals.duePayable > 0) model.payment.reference = model.number;
    const issues = checkModel(model, formats);
    try {
      const pdf = await this.renderer.renderPdf(ctx, model);
      return { pdf: `data:application/pdf;base64,${pdf.toString('base64')}`, issues };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { pdf: null, issues: [...issues, { code: 'RENDER_FAILED', message }] };
    }
  }

  /** Invoice total minus its credit notes. */
  remainingAmount(ctx: RequestContext, invoice: EInvoice) {
    return this.creditNotes.remainingAmount(ctx, invoice);
  }

  creditNotesOf(ctx: RequestContext, invoiceId: ID) {
    return this.creditNotes.creditNotesOf(ctx, invoiceId);
  }

  /** Credit note for a settled refund (job). */
  async creditRefund(ctx: RequestContext, refundId: ID): Promise<EInvoice | undefined> {
    const settings = await this.settings.get(ctx);
    if (!settings.enabled) return undefined;
    const note = await this.connection.withTransaction(ctx, async (txCtx) => {
      const refund = await this.connection
        .getRepository(txCtx, Refund)
        .findOne({ where: { id: refundId }, relations: ['payment', 'payment.order'] });
      if (!refund) throw new Error(`Refund ${refundId} not found`);
      if (!(await lockOrder(this.connection, txCtx, refund.payment.order.id))) return undefined;
      return this.creditNotes.creditRefund(txCtx, refundId);
    });
    if (note) await this.afterIssue(ctx, [note]);
    return note;
  }

  /**
   * The one place that decides what happens with an order after a state change.
   * Runs with the order row locked, so concurrent triggers for the same order are serialized.
   *
   * - Cancelled: the open invoice is credited in full; a BLOCKED invoice (no number) is removed.
   * - Modified (the amounts differ from the invoiced ones): full credit note + new invoice (Q6).
   * - No invoice yet and the order reached an `issueOnStates` state: issue one.
   */
  async reconcile(ctx: RequestContext, orderId: ID): Promise<EInvoice[]> {
    const settings = await this.settings.get(ctx);
    if (!settings.enabled) return [];
    const docs = await this.connection.withTransaction(ctx, async (txCtx): Promise<EInvoice[]> => {
      const order = await lockOrder(this.connection, txCtx, orderId);
      if (!order) return [];
      const repo = this.connection.getRepository(txCtx, EInvoice);
      const blocked = await repo.findOne({ where: { orderId, type: 'invoice', status: 'BLOCKED' } });
      const open = await this.openInvoice(txCtx, orderId);

      if (order.state === 'Cancelled') {
        // A blocked invoice has no number, so removing it leaves no gap
        if (blocked) await repo.remove(blocked);
        if (!open || !this.options.autoCreditNotes) return [];
        return [await this.creditNotes.credit(txCtx, open, { full: true }, { reason: 'cancellation' })];
      }
      if (UNSETTLED_STATES.includes(order.state)) return [];

      if (open) {
        if (!open.orderFingerprint || !this.options.autoCreditNotes) return [];
        const current = await this.mapper.loadOrder(txCtx, orderId);
        if (!current || orderFingerprint(current) === open.orderFingerprint) return [];
        const note = await this.creditNotes.credit(txCtx, open, { full: true }, { reason: 'modification', settlement: 'offset' });
        return [note, await this.issue(txCtx, orderId, 'modification')];
      }
      if (!this.options.issueOnStates.includes(order.state) || !settings.autoIssue) return [];
      return [await this.issue(txCtx, orderId, blocked?.reason ?? 'auto')];
    });
    await this.afterIssue(ctx, docs);
    return docs;
  }

  /**
   * Maps and checks the order; when the checks pass, reserves the number and stores the snapshot (PENDING).
   * Must run inside a transaction with the order locked. Reuses a BLOCKED invoice of the order if there is one.
   */
  private async issue(ctx: RequestContext, orderId: ID, reason: EInvoiceReason): Promise<EInvoice> {
    const order = await this.mapper.loadOrder(ctx, orderId);
    if (!order) throw new UserInputError(`Order ${orderId} not found`);
    const mapped = await this.mapper.toModel(ctx, order);
    if (!mapped) throw new UserInputError('E-invoicing is not set up for this channel (no seller data)');
    const { model, formats } = mapped;
    model.totals = calculate(model, {
      expectedTotalWithTax: order.totalWithTax,
      fallbackThreshold: this.options.roundingFallbackThreshold,
    });

    const repo = this.connection.getRepository(ctx, EInvoice);
    const invoice =
      (await repo.findOne({ where: { orderId, type: 'invoice', status: 'BLOCKED' } })) ??
      new EInvoice({ channelId: ctx.channelId, orderId, type: 'invoice', reason, files: [] });
    Object.assign(invoice, {
      currencyCode: model.currencyCode,
      totalNet: model.totals.taxBasisTotal,
      totalTax: model.totals.taxTotal,
      totalWithTax: model.totals.grandTotal + model.totals.roundingAmount,
      formats,
      orderFingerprint: orderFingerprint(order),
    });

    const issues = checkModel(model, formats);
    if (issues.length) {
      Object.assign(invoice, { status: 'BLOCKED', model, issues });
      const saved = await repo.save(invoice);
      Logger.warn(`E-invoice for order ${order.code} is blocked: ${issues.map((i) => i.code).join(', ')}`, loggerCtx);
      await this.eventBus.publish(new EInvoiceBlockedEvent(ctx, saved, issues));
      return saved;
    }

    const reserved = await this.numbers.reserve(ctx, { type: 'invoice', order, issueDate: model.issueDate });
    model.number = reserved.number;
    if (model.totals.duePayable > 0) model.payment.reference = reserved.number;
    // Fail fast: a serializer error rolls back the transaction, so no number is consumed
    toCii(model, 'zugferd');

    Object.assign(invoice, {
      status: 'PENDING',
      number: reserved.number,
      sequenceKey: reserved.key,
      sequenceValue: reserved.value,
      issueDate: model.issueDate,
      model,
      issues: null,
      errorMessage: null,
    });
    return repo.save(invoice);
  }

  /** After the issuing transaction has committed: start rendering. */
  private async afterIssue(ctx: RequestContext, docs: EInvoice[]) {
    for (const doc of docs) {
      if (doc.status === 'PENDING') await this.enqueue({ type: 'render', invoiceId: doc.id, ctx: ctx.serialize() });
    }
  }

  private async enqueue(data: JobData) {
    await this.queue.add(data, { retries: 3 }).catch((e) => Logger.error(`Could not add e-invoice job: ${e}`, loggerCtx));
  }

  /** The order's current invoice, unless it has been credited in full. */
  private async openInvoice(ctx: RequestContext, orderId: ID): Promise<EInvoice | null> {
    const latest = await this.creditNotes.latestInvoice(ctx, orderId);
    return latest && (await this.creditNotes.remainingAmount(ctx, latest)) > 0 ? latest : null;
  }

  /** Loads an invoice of the current channel and locks its order. */
  private async lockedInvoice(ctx: RequestContext, invoiceId: ID): Promise<EInvoice> {
    const invoice = await this.findOne(ctx, invoiceId);
    if (!invoice) throw new UserInputError(`E-invoice ${invoiceId} not found`);
    await lockOrder(this.connection, ctx, invoice.orderId);
    if (invoice.type !== 'invoice') throw new UserInputError(`${invoice.number ?? invoiceId} is not an invoice`);
    if (!NUMBERED_STATUSES.includes(invoice.status as (typeof NUMBERED_STATUSES)[number])) {
      throw new UserInputError(`Invoice ${invoice.number ?? invoiceId} is ${invoice.status} and cannot be credited`);
    }
    return invoice;
  }
}
