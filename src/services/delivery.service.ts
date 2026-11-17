import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, ID, Logger, Order, RequestContext, TransactionalConnection, UserInputError } from '@vendure/core';
import { MoreThan } from 'typeorm';

import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { EInvoiceModel, pdfLabels } from '../core';
import { EInvoice, EInvoiceChannelSettings, EInvoiceDelivery, EInvoiceDeliveryTrigger } from '../entities';
import { EInvoiceDeliveryFailedEvent, EInvoiceIssuedEvent, InvoiceDownloadLinkRequestedEvent } from '../events';
import { ResolvedEInvoicePluginOptions } from '../options';

import { ChannelSettingsService, isEmailAddress } from './channel-settings.service';
import { DownloadLinkService } from './download-link.service';

/** Longest stored error message. */
const MAX_ERROR = 2000;

/**
 * An attachment as the EmailPlugin (nodemailer) takes it. The content is a base64 string: the EmailPlugin stores
 * attachments as JSON in its job data, where a `Buffer` would become an array of numbers.
 *
 * @category Services
 */
export interface DeliveryAttachment {
  filename: string;
  content: string;
  encoding: 'base64';
  contentType: string;
}

/**
 * Everything an email for one delivery needs; built by {@link EInvoiceDeliveryService.prepareEmail}.
 *
 * @category Services
 */
export interface DeliveryEmail {
  /** BCP 47 language of the document, e.g. `de` */
  languageCode: string;
  subject: string;
  attachments: DeliveryAttachment[];
  /** Variables of the email template `e-invoice-delivery/body.hbs` */
  templateVars: DeliveryTemplateVars;
}

/**
 * Variables of the email template `e-invoice-delivery/body.hbs`.
 *
 * @category Services
 */
export interface DeliveryTemplateVars {
  subject: string;
  /** The document language is German */
  german: boolean;
  isCreditNote: boolean;
  /** "Rechnung", "Invoice", … (the PDF label) */
  documentLabel: string;
  number: string;
  /** Issue date as people write it in the document language (`17.11.2026`, `2026-11-17`) */
  issueDate: string;
  /** Issue date as `YYYY-MM-DD` */
  issueDateIso: string;
  /** Total with VAT in minor units, for `{{ formatMoney totalWithTax currencyCode }}` */
  totalWithTax: number;
  currencyCode: string;
  orderCode: string;
  buyerName: string;
  sellerName: string;
  /** The email contains an XRechnung: the XML is the authoritative document, the PDF is for reading */
  hasXRechnung: boolean;
  /** Download links instead of attachments (files larger than `delivery.maxAttachmentBytes`) */
  linkOnly: boolean;
  /** The files; `url` is set when `linkOnly` */
  files: { fileName: string; url?: string }[];
}

/**
 * Sends issued documents to the buyer and keeps the {@link EInvoiceDelivery} rows: automatically when a document is
 * issued (channel setting), manually from the dashboard, and on a buyer's request (`requestInvoiceDownloadLink`).
 * The transport is the {@link InvoiceDeliveryStrategy} (default: the Vendure EmailPlugin).
 *
 * @category Services
 */
@Injectable()
export class EInvoiceDeliveryService implements OnApplicationBootstrap {
  /** @internal */
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private eventBus: EventBus,
    private settings: ChannelSettingsService,
    private links: DownloadLinkService,
  ) {}

  /** @internal */
  onApplicationBootstrap() {
    this.eventBus.ofType(EInvoiceIssuedEvent).subscribe((event) => {
      this.sendIssued(event.ctx, event.invoice).catch((e) =>
        Logger.error(`Could not send e-invoice ${event.invoice.number}: ${errorText(e)}`, loggerCtx),
      );
    });
  }

  /** The deliveries of a document, newest first. */
  findByInvoice(ctx: RequestContext, invoiceId: ID): Promise<EInvoiceDelivery[]> {
    return this.connection.getRepository(ctx, EInvoiceDelivery).find({
      where: { invoiceId, channelId: ctx.channelId },
      order: { queuedAt: 'DESC', id: 'DESC' },
    });
  }

  /**
   * Sends an issued document again (admin), to `recipient` or to the buyer's address. No BCC: the archive got the
   * automatic sending already.
   */
  async send(ctx: RequestContext, invoiceId: ID, recipient?: string | null): Promise<EInvoiceDelivery> {
    const invoice = await this.connection.getRepository(ctx, EInvoice).findOne({
      where: { id: invoiceId, channelId: ctx.channelId },
      relations: ['files'],
    });
    if (!invoice) throw new UserInputError(`E-invoice ${invoiceId} not found`);
    if (invoice.status !== 'ISSUED') throw new UserInputError(`E-invoice ${invoice.number ?? invoiceId} is not issued`);
    const to = recipient?.trim() || (await this.defaultRecipient(ctx, invoice));
    if (recipient?.trim() && !isEmailAddress(to ?? '')) throw new UserInputError(`"${recipient}" is not a valid email address`);
    return this.start(ctx, invoice, { trigger: 'manual', recipient: to, bcc: null });
  }

  /**
   * Shop API `requestInvoiceDownloadLink`: if the order code and the order's email address match, sends the issued
   * documents of the order to that address again (unless the rate limit is reached). Never tells the caller whether
   * anything matched.
   */
  async requestDocuments(ctx: RequestContext, orderCode: string, emailAddress: string): Promise<void> {
    const email = emailAddress?.trim().toLowerCase();
    if (!orderCode?.trim() || !email) return;
    const order = await this.connection
      .getRepository(ctx, Order)
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.customer', 'customer')
      .innerJoin('order.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
      .where('order.code = :code', { code: orderCode.trim() })
      .getOne();
    const orderEmail = order?.customer?.emailAddress?.trim().toLowerCase();
    if (!order || !orderEmail || orderEmail !== email) return;

    const invoices = await this.connection.getRepository(ctx, EInvoice).find({
      where: { orderId: order.id, channelId: ctx.channelId, status: 'ISSUED' },
      relations: ['files'],
      order: { position: 'ASC' },
    });
    const allowed = invoices.length > 0 && (await this.requestsInWindow(ctx, order.id)) < this.options.delivery.requestLimit.max;
    const deliveries: EInvoiceDelivery[] = [];
    if (allowed) {
      for (const invoice of invoices) {
        deliveries.push(await this.start(ctx, invoice, { trigger: 'request', recipient: order.customer!.emailAddress, bcc: null }));
      }
    } else if (invoices.length) {
      Logger.warn(`Document request for order ${order.code} ignored: rate limit reached`, loggerCtx);
    }
    await this.eventBus.publish(new InvoiceDownloadLinkRequestedEvent(ctx, order, emailAddress.trim(), deliveries, allowed));
  }

  /**
   * Builds the email of a delivery: subject, template variables and the stored files as attachments (or download
   * links above `delivery.maxAttachmentBytes`). Called by `eInvoiceDeliveryHandler`; a custom strategy can use it
   * too. If it fails, the delivery is `failed`.
   */
  async prepareEmail(ctx: RequestContext, deliveryId: ID): Promise<DeliveryEmail> {
    const delivery = await this.connection.getRepository(ctx, EInvoiceDelivery).findOne({ where: { id: deliveryId } });
    if (!delivery) throw new Error(`E-invoice delivery ${deliveryId} not found`);
    try {
      const invoice = await this.connection
        .getRepository(ctx, EInvoice)
        .findOneOrFail({ where: { id: delivery.invoiceId }, relations: ['files'] });
      const model = invoice.model as EInvoiceModel;
      const files = [...invoice.files].sort(
        (a, b) => (a.mimeType === 'application/pdf' ? -1 : 0) - (b.mimeType === 'application/pdf' ? -1 : 0),
      );
      const linkOnly = files.reduce((sum, f) => sum + f.size, 0) > this.options.delivery.maxAttachmentBytes;
      const attachments: DeliveryAttachment[] = [];
      const fileVars: DeliveryTemplateVars['files'] = [];
      for (const file of files) {
        if (linkOnly) {
          fileVars.push({ fileName: file.fileName, url: this.links.fileLink(ctx, invoice, file.format, 'guest') });
        } else {
          const data = await this.options.storage.read(ctx, file.storageId);
          attachments.push({ filename: file.fileName, content: data.toString('base64'), encoding: 'base64', contentType: file.mimeType });
          fileVars.push({ fileName: file.fileName });
        }
      }
      if (linkOnly) await this.connection.getRepository(ctx, EInvoiceDelivery).update({ id: delivery.id }, { linkOnly: true });

      const labels = pdfLabels(model.language, this.options.pdf.translations);
      const documentLabel = invoice.type === 'credit_note' ? labels.creditNote : labels.invoice;
      const subject = `${documentLabel} ${invoice.number} – ${model.seller.tradingName || model.seller.name}`;
      return {
        languageCode: model.language,
        subject,
        attachments,
        templateVars: {
          subject,
          german: model.language.toLowerCase().startsWith('de'),
          isCreditNote: invoice.type === 'credit_note',
          documentLabel,
          number: invoice.number ?? '',
          issueDate: formatDate(invoice.issueDate ?? '', model.language),
          issueDateIso: invoice.issueDate ?? '',
          totalWithTax: invoice.totalWithTax,
          currencyCode: invoice.currencyCode,
          orderCode: model.meta.orderCode,
          buyerName: model.buyer.name,
          sellerName: model.seller.tradingName || model.seller.name,
          hasXRechnung: invoice.formats.some((f) => f.startsWith('xrechnung')),
          linkOnly,
          files: fileVars,
        },
      };
    } catch (e) {
      await this.recordAttempt(ctx, delivery.id, { success: false, error: `Could not prepare the email: ${errorText(e)}`, final: true });
      throw e;
    }
  }

  /**
   * Records the outcome of one attempt of the transport. A failure sets `retrying` (the transport tries again), or
   * `failed` with `final: true` or once `attempts` reaches `maxAttempts`; `failed` publishes
   * {@link EInvoiceDeliveryFailedEvent}. Ignored for deliveries that are `sent` or `failed` already.
   */
  async recordAttempt(
    ctx: RequestContext,
    deliveryId: ID,
    outcome: { success: boolean; error?: string; final?: boolean; maxAttempts?: number },
  ): Promise<EInvoiceDelivery | undefined> {
    const repo = this.connection.getRepository(ctx, EInvoiceDelivery);
    const delivery = await repo.findOne({ where: { id: deliveryId } });
    if (!delivery || delivery.status === 'sent' || delivery.status === 'failed') return delivery ?? undefined;
    delivery.attempts += 1;
    if (outcome.success) {
      Object.assign(delivery, { status: 'sent', sentAt: new Date(), errorMessage: null });
      return repo.save(delivery);
    }
    const error = (outcome.error || 'Unknown error').slice(0, MAX_ERROR);
    const final = outcome.final || (outcome.maxAttempts !== undefined && delivery.attempts >= outcome.maxAttempts);
    Object.assign(delivery, { status: final ? 'failed' : 'retrying', errorMessage: error });
    const saved = await repo.save(delivery);
    if (final) {
      Logger.warn(`Sending e-invoice delivery ${delivery.id} to ${delivery.recipient} failed: ${error}`, loggerCtx);
      await this.eventBus.publish(new EInvoiceDeliveryFailedEvent(ctx, saved, error));
    }
    return saved;
  }

  /**
   * Problems of the delivery setup (strategy) while delivery is enabled for a channel; logged at startup.
   *
   * @internal
   */
  async logSetupIssues(): Promise<void> {
    try {
      const enabled = await this.connection.rawConnection
        .getRepository(EInvoiceChannelSettings)
        .count({ where: { deliveryEnabled: true } });
      if (!enabled) return;
      for (const issue of await this.setupIssues()) Logger.warn(`Delivery: ${issue}`, loggerCtx);
    } catch (e) {
      // e.g. the migration for the delivery columns has not run yet; startup must not fail because of a warning
      Logger.warn(`Could not check the delivery setup: ${errorText(e)}`, loggerCtx);
    }
  }

  /** @internal */
  async setupIssues(): Promise<string[]> {
    return (await this.options.delivery.strategy.setupIssues?.()) ?? [];
  }

  /** Automatic sending after a document has been issued. */
  private async sendIssued(ctx: RequestContext, invoice: EInvoice) {
    const settings = await this.settings.get(ctx);
    if (!settings.enabled || !settings.deliveryEnabled) return;
    const { autoSend } = this.options.delivery;
    const wanted = invoice.type === 'credit_note' ? autoSend.creditNotes.includes(invoice.reason) : autoSend.invoices;
    if (!wanted) return;
    const full = await this.connection.getRepository(ctx, EInvoice).findOne({ where: { id: invoice.id }, relations: ['files'] });
    if (!full) return;
    await this.start(ctx, full, { trigger: 'auto', recipient: await this.defaultRecipient(ctx, full), bcc: settings.deliveryBcc || null });
  }

  /** Saves the delivery row and hands it to the strategy. Without a recipient the row is `failed` right away. */
  private async start(
    ctx: RequestContext,
    invoice: EInvoice,
    input: { trigger: EInvoiceDeliveryTrigger; recipient: string | undefined; bcc: string | null },
  ): Promise<EInvoiceDelivery> {
    const repo = this.connection.getRepository(ctx, EInvoiceDelivery);
    const delivery = await repo.save(
      new EInvoiceDelivery({
        channelId: invoice.channelId,
        invoiceId: invoice.id,
        orderId: invoice.orderId,
        trigger: input.trigger,
        status: 'queued',
        recipient: input.recipient ?? '',
        bcc: input.bcc,
        attempts: 0,
        linkOnly: false,
        errorMessage: null,
        queuedAt: new Date(),
        sentAt: null,
      }),
    );
    if (!input.recipient) {
      return (
        (await this.recordAttempt(ctx, delivery.id, {
          success: false,
          error: 'No recipient: the order has no email address',
          final: true,
        })) ?? delivery
      );
    }
    try {
      await this.options.delivery.strategy.deliver(ctx, { delivery, invoice });
    } catch (e) {
      return (await this.recordAttempt(ctx, delivery.id, { success: false, error: errorText(e), final: true })) ?? delivery;
    }
    return (await repo.findOne({ where: { id: delivery.id } })) ?? delivery;
  }

  /** The buyer's email address on the document (BT-49, scheme EM), else the email address of the order's customer. */
  private async defaultRecipient(ctx: RequestContext, invoice: EInvoice): Promise<string | undefined> {
    const address = invoice.model?.buyer.electronicAddress;
    if (address?.scheme === 'EM' && isEmailAddress(address.value)) return address.value;
    const order = await this.connection.getRepository(ctx, Order).findOne({ where: { id: invoice.orderId }, relations: ['customer'] });
    const email = order?.customer?.emailAddress?.trim();
    return email && isEmailAddress(email) ? email : undefined;
  }

  /**
   * How often the documents of the order were requested within the window. All issued documents are sent on each
   * request, so the highest count per document is the number of requests.
   */
  private async requestsInWindow(ctx: RequestContext, orderId: ID): Promise<number> {
    const since = new Date(Date.now() - this.options.delivery.requestLimit.window * 1000);
    const rows = await this.connection.getRepository(ctx, EInvoiceDelivery).find({
      select: ['id', 'invoiceId'],
      where: { orderId, trigger: 'request', queuedAt: MoreThan(since) },
    });
    const perInvoice = new Map<string, number>();
    for (const row of rows) perInvoice.set(String(row.invoiceId), (perInvoice.get(String(row.invoiceId)) ?? 0) + 1);
    return Math.max(0, ...perInvoice.values());
  }
}

function formatDate(iso: string, language: string): string {
  const [y, m, d] = iso.split('-');
  return language.toLowerCase().startsWith('de') && d ? `${d}.${m}.${y}` : iso;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
