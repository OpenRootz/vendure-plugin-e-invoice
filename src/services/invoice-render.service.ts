import { Inject, Injectable } from '@nestjs/common';
import { Asset, ConfigService, EventBus, ID, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { createHash } from 'crypto';

import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { EInvoiceFormat, EInvoiceModel, pdfLabels, PdfTemplateInput, renderZugferdPdf, toCii, toUbl } from '../core';
import { EInvoice, EInvoiceFile } from '../entities';
import { EInvoiceFailedEvent, EInvoiceIssuedEvent } from '../events';
import { ResolvedEInvoicePluginOptions } from '../options';

import { ChannelSettingsService } from './channel-settings.service';

export interface RenderedFile {
  format: EInvoiceFormat;
  fileName: string;
  mimeType: string;
  data: Buffer;
}

/**
 * Phase 2: renders the files of a PENDING (or FAILED) invoice from its snapshot and stores them.
 * The order is never read here, so a retry produces the same document data.
 */
@Injectable()
export class InvoiceRenderService {
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private configService: ConfigService,
    private eventBus: EventBus,
    private settings: ChannelSettingsService,
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
      const files = await this.renderFiles(ctx, invoice.model as EInvoiceModel, invoice.formats);
      const issued = await this.connection.withTransaction(ctx, async (txCtx) => {
        const model = invoice.model as EInvoiceModel;
        const fileRepo = this.connection.getRepository(txCtx, EInvoiceFile);
        for (const file of files) {
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

  async renderFiles(ctx: RequestContext, model: EInvoiceModel, formats: EInvoiceFormat[]): Promise<RenderedFile[]> {
    const base = fileBaseName(model.number);
    const files: RenderedFile[] = [];
    for (const format of formats) {
      switch (format) {
        case 'zugferd':
          files.push({ format, fileName: `${base}.pdf`, mimeType: 'application/pdf', data: await this.renderPdf(ctx, model) });
          break;
        case 'xrechnung-cii':
          files.push(xmlFile(format, `${base}-xrechnung.xml`, toCii(model, 'xrechnung')));
          break;
        case 'xrechnung-ubl':
          files.push(xmlFile(format, `${base}-xrechnung-ubl.xml`, toUbl(model)));
          break;
      }
    }
    return files;
  }

  /** ZUGFeRD PDF: the layout from the PDF strategy, the CII XML embedded. */
  async renderPdf(ctx: RequestContext, model: EInvoiceModel): Promise<Buffer> {
    const settings = await this.settings.get(ctx);
    const labels = pdfLabels(model.language, this.options.pdf.translations);
    const input: PdfTemplateInput = {
      model,
      labels,
      layout: settings.layout,
      logo: settings.layout.logoAssetId ? await this.loadLogo(ctx, settings.layout.logoAssetId) : undefined,
    };
    const definition = await this.options.pdfStrategy.buildDocDefinition(ctx, input);
    return renderZugferdPdf({
      model,
      xml: toCii(model, 'zugferd'),
      definition,
      title: `${model.type === 'credit_note' ? labels.creditNote : labels.invoice} ${model.number}`,
      fonts: this.options.pdf.fonts,
    });
  }

  /** Reads the logo asset from the asset storage. PNG and JPEG are embedded as images, SVG as vector graphic. */
  private async loadLogo(ctx: RequestContext, assetId: ID): Promise<PdfTemplateInput['logo']> {
    const asset = await this.connection.getRepository(ctx, Asset).findOne({ where: { id: assetId } });
    if (!asset) {
      Logger.warn(`Logo asset ${assetId} not found; rendering without logo`, loggerCtx);
      return undefined;
    }
    const data = await this.configService.assetOptions.assetStorageStrategy.readFileToBuffer(asset.source);
    if (asset.mimeType === 'image/png' || asset.mimeType === 'image/jpeg') {
      return { dataUrl: `data:${asset.mimeType};base64,${data.toString('base64')}` };
    }
    if (asset.mimeType === 'image/svg+xml') return { svg: data.toString('utf8') };
    Logger.warn(`Logo asset ${assetId} has unsupported type ${asset.mimeType} (use PNG, JPEG or SVG)`, loggerCtx);
    return undefined;
  }
}

/** File names are derived from the invoice number; characters that are unsafe in file names are replaced. */
export function fileBaseName(number: string): string {
  return number.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function xmlFile(format: EInvoiceFormat, fileName: string, content: string): RenderedFile {
  return { format, fileName, mimeType: 'application/xml', data: Buffer.from(content, 'utf8') };
}
