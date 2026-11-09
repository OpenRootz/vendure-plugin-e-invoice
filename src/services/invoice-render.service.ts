import { Inject, Injectable } from '@nestjs/common';
import { EventBus, ID, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { createHash } from 'crypto';

import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { EInvoiceFormat, EInvoiceModel, toCii, toUbl } from '../core';
import { EInvoice, EInvoiceFile } from '../entities';
import { EInvoiceFailedEvent, EInvoiceIssuedEvent } from '../events';
import { ResolvedEInvoicePluginOptions } from '../options';

export interface RenderedFile {
  format: EInvoiceFormat;
  fileName: string;
  mimeType: string;
  data: Buffer;
}

/**
 * Phase 2: renders the files of a PENDING (or FAILED) invoice from its snapshot and stores them.
 * The order is never read here, so a retry always produces the same document.
 */
@Injectable()
export class InvoiceRenderService {
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private eventBus: EventBus,
  ) {}

  async render(ctx: RequestContext, invoiceId: ID): Promise<EInvoice | undefined> {
    const repo = this.connection.getRepository(ctx, EInvoice);
    const invoice = await repo.findOne({ where: { id: invoiceId } });
    if (!invoice) {
      // The issuing transaction may not have committed yet; the job retries
      throw new Error(`E-invoice ${invoiceId} not found`);
    }
    if (invoice.status !== 'PENDING' && invoice.status !== 'FAILED') return invoice;

    try {
      const issued = await this.connection.withTransaction(ctx, async (txCtx) => {
        const model = invoice.model as EInvoiceModel;
        const fileRepo = this.connection.getRepository(txCtx, EInvoiceFile);
        for (const file of renderFiles(model, invoice.formats)) {
          const storageId = await this.options.storage.save(txCtx, {
            key: `${model.meta.channelCode}/${model.issueDate.slice(0, 4)}/${file.fileName}`,
            data: file.data,
            mimeType: file.mimeType,
            channelId: invoice.channelId,
          });
          await fileRepo.save(
            new EInvoiceFile({
              invoiceId: invoice.id,
              format: file.format,
              fileName: file.fileName,
              mimeType: file.mimeType,
              size: file.data.length,
              sha256: createHash('sha256').update(file.data).digest('hex'),
              storageId,
            }),
          );
        }
        invoice.status = 'ISSUED';
        invoice.errorMessage = null;
        const saved = await this.connection.getRepository(txCtx, EInvoice).save(invoice);
        await this.eventBus.publish(new EInvoiceIssuedEvent(txCtx, saved));
        return saved;
      });
      Logger.info(`Issued e-invoice ${issued.number}`, loggerCtx);
      return issued;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await repo.update({ id: invoice.id }, { status: 'FAILED', errorMessage: message });
      Object.assign(invoice, { status: 'FAILED', errorMessage: message });
      Logger.error(`Rendering e-invoice ${invoice.number} failed: ${message}`, loggerCtx);
      await this.eventBus.publish(new EInvoiceFailedEvent(ctx, invoice, message));
      throw e;
    }
  }
}

/** File names are derived from the invoice number; characters that are unsafe in file names are replaced. */
export function renderFiles(model: EInvoiceModel, formats: EInvoiceFormat[]): RenderedFile[] {
  const base = model.number.replace(/[^A-Za-z0-9._-]+/g, '_');
  const xml = (format: EInvoiceFormat, suffix: string, content: string): RenderedFile => ({
    format,
    fileName: `${base}${suffix}.xml`,
    mimeType: 'application/xml',
    data: Buffer.from(content, 'utf8'),
  });
  return formats.map((format) => {
    switch (format) {
      // The ZUGFeRD PDF (with this XML embedded) follows with the PDF renderer
      case 'zugferd':
        return xml(format, '-zugferd', toCii(model, 'zugferd'));
      case 'xrechnung-cii':
        return xml(format, '-xrechnung', toCii(model, 'xrechnung'));
      case 'xrechnung-ubl':
        return xml(format, '-xrechnung-ubl', toUbl(model));
    }
  });
}
