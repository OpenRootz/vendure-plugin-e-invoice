import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
  EventBus,
  ID,
  JobQueue,
  JobQueueService,
  Logger,
  Order,
  OrderStateTransitionEvent,
  RequestContext,
  SerializedRequestContext,
  TransactionalConnection,
  UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';

import { E_INVOICE_QUEUE, loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { calculate, checkModel, toCii } from '../core';
import { EInvoice, EInvoiceReason } from '../entities';
import { EInvoiceBlockedEvent } from '../events';
import { OrderModelMapper } from '../mapping/order-model.mapper';
import { ResolvedEInvoicePluginOptions } from '../options';

import { ChannelSettingsService } from './channel-settings.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoiceRenderService } from './invoice-render.service';

type JobData =
  | { type: 'reconcile'; orderId: ID; ctx: SerializedRequestContext }
  | { type: 'render'; invoiceId: ID; ctx: SerializedRequestContext };

/** Invoices that count as "the order has an invoice" (a BLOCKED one has no number yet). */
const OPEN_STATUSES = ['PENDING', 'ISSUED', 'FAILED'] as const;

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
  ) {}

  async onApplicationBootstrap() {
    this.queue = await this.jobQueueService.createQueue<JobData>({
      name: E_INVOICE_QUEUE,
      process: async (job) => {
        const ctx = RequestContext.deserialize(job.data.ctx);
        if (job.data.type === 'reconcile') await this.reconcile(ctx, job.data.orderId);
        else await this.renderer.render(ctx, job.data.invoiceId);
      },
    });

    this.eventBus.ofType(OrderStateTransitionEvent).subscribe((event) => {
      if (this.options.issueOnStates.includes(event.toState) || event.toState === 'Cancelled') {
        this.enqueue({ type: 'reconcile', orderId: event.order.id, ctx: event.ctx.serialize() });
      }
    });
  }

  findOne(ctx: RequestContext, id: ID): Promise<EInvoice | null> {
    return this.connection.getRepository(ctx, EInvoice).findOne({
      where: { id, channelId: ctx.channelId },
      relations: ['files'],
    });
  }

  findByOrder(ctx: RequestContext, orderId: ID): Promise<EInvoice[]> {
    return this.connection.getRepository(ctx, EInvoice).find({
      where: { orderId, channelId: ctx.channelId },
      relations: ['files'],
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Manual creation (admin). The checks run synchronously, so problems are returned immediately
   * as a BLOCKED invoice with `issues`; the files are rendered in the background.
   */
  async create(ctx: RequestContext, orderId: ID): Promise<EInvoice> {
    const invoice = await this.connection.withTransaction(ctx, async (txCtx) => {
      const order = await this.lockOrder(txCtx, orderId);
      if (!order) throw new UserInputError(`Order ${orderId} not found`);
      const open = await this.openInvoice(txCtx, orderId);
      if (open) throw new UserInputError(`Order ${order.code} already has invoice ${open.number}`);
      return this.issue(txCtx, orderId, 'manual');
    });
    await this.afterIssue(ctx, invoice);
    return invoice;
  }

  /** BLOCKED: map the order again (the cause may be fixed). FAILED: render again from the snapshot. */
  async retry(ctx: RequestContext, id: ID): Promise<EInvoice> {
    const existing = await this.findOne(ctx, id);
    if (!existing) throw new UserInputError(`E-invoice ${id} not found`);
    if (existing.status === 'FAILED') {
      await this.enqueue({ type: 'render', invoiceId: existing.id, ctx: ctx.serialize() });
      return existing;
    }
    if (existing.status !== 'BLOCKED') throw new UserInputError(`E-invoice ${id} is ${existing.status} and cannot be retried`);
    const invoice = await this.connection.withTransaction(ctx, async (txCtx) => {
      await this.lockOrder(txCtx, existing.orderId);
      return this.issue(txCtx, existing.orderId, existing.reason);
    });
    await this.afterIssue(ctx, invoice);
    return invoice;
  }

  /**
   * The one place that decides what happens with an order after a state change.
   * Runs with the order row locked, so concurrent triggers for the same order are serialized.
   */
  async reconcile(ctx: RequestContext, orderId: ID): Promise<EInvoice | undefined> {
    const settings = await this.settings.get(ctx);
    if (!settings.enabled) return undefined;
    const invoice = await this.connection.withTransaction(ctx, async (txCtx) => {
      const order = await this.lockOrder(txCtx, orderId);
      if (!order) return undefined;
      const repo = this.connection.getRepository(txCtx, EInvoice);
      const blocked = await repo.findOne({ where: { orderId, type: 'invoice', status: 'BLOCKED' } });

      if (order.state === 'Cancelled') {
        // A blocked invoice has no number, so removing it leaves no gap. Credit notes for issued invoices: M7.
        if (blocked) await repo.remove(blocked);
        return undefined;
      }
      if (await this.openInvoice(txCtx, orderId)) return undefined;
      if (!this.options.issueOnStates.includes(order.state) || !settings.autoIssue) return undefined;
      return this.issue(txCtx, orderId, blocked?.reason ?? 'auto');
    });
    if (invoice) await this.afterIssue(ctx, invoice);
    return invoice;
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
  private async afterIssue(ctx: RequestContext, invoice: EInvoice) {
    if (invoice.status === 'PENDING') {
      await this.enqueue({ type: 'render', invoiceId: invoice.id, ctx: ctx.serialize() });
    }
  }

  private async enqueue(data: JobData) {
    await this.queue.add(data, { retries: 3 }).catch((e) => Logger.error(`Could not add e-invoice job: ${e}`, loggerCtx));
  }

  private openInvoice(ctx: RequestContext, orderId: ID): Promise<EInvoice | null> {
    return this.connection
      .getRepository(ctx, EInvoice)
      .findOne({ where: { orderId, type: 'invoice', status: In([...OPEN_STATUSES]) }, order: { createdAt: 'DESC' } });
  }

  /** Locks the order row for the rest of the transaction (no-op on SQLite, which serializes writes). */
  private lockOrder(ctx: RequestContext, orderId: ID): Promise<Order | null> {
    const qb = this.connection
      .getRepository(ctx, Order)
      .createQueryBuilder('locked_order')
      .innerJoin('locked_order.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
      .where('locked_order.id = :orderId', { orderId });
    const type = this.connection.rawConnection.options.type;
    if (type !== 'sqljs' && type !== 'sqlite' && type !== 'better-sqlite3') qb.setLock('pessimistic_write', undefined, ['locked_order']);
    return qb.getOne();
  }
}
