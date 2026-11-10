import { Inject, Injectable } from '@nestjs/common';
import { Asset, ConfigService, EventBus, ID, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { createHash } from 'crypto';

import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import {
  defaultFonts,
  EInvoiceFormat,
  EInvoiceModel,
  LayoutResult,
  pdfLabels,
  PdfImage,
  PdfTemplateInput,
  renderZugferdPdf,
  toCii,
  toUbl,
} from '../core';
import { EInvoice, EInvoiceFile, LayoutSettings, ValidationSummary } from '../entities';
import { EInvoiceFailedEvent, EInvoiceIssuedEvent } from '../events';
import { ResolvedEInvoicePluginOptions } from '../options';

import { ChannelSettingsService, MAX_LOGO_BYTES } from './channel-settings.service';

export interface RenderedFile {
  format: EInvoiceFormat;
  fileName: string;
  mimeType: string;
  data: Buffer;
  /** The XML of the document; for the ZUGFeRD PDF the embedded CII XML */
  xml: string;
  /** Layout warnings of the PDF (content printed beyond a frame); added to the validation summary */
  warnings?: { code: string; text: string }[];
}

/** Rendering succeeded, but the validator rejected a document (`validation.mode: 'enforce'`). */
export class ValidationFailedError extends Error {
  constructor(public summary: ValidationSummary) {
    const errors = summary.results.flatMap((r) => r.messages.filter((m) => m.level === 'error'));
    const detail = summary.error ?? errors.slice(0, 5).map((m) => (m.code ? `${m.code}: ${m.text}` : m.text)).join('; ');
    super(`Validation failed${detail ? `: ${detail}` : ''}`);
  }
}

/** Keep the stored summary small */
const MAX_MESSAGES = 50;

const IMAGE_CACHE_SIZE = 16;

export interface RenderPdfOptions {
  /** Draft layout (preview); replaces the saved layout */
  layout?: LayoutSettings;
  /** Skip images larger than {@link MAX_LOGO_BYTES} and report them */
  enforceLogoLimit?: boolean;
}

export interface RenderedPdf {
  pdf: Buffer;
  pageCount: number;
  /** Problems with the layout resources, e.g. a logo that could not be used */
  issues: { code: string; message: string; path?: string }[];
  /** The measured layout (built-in PDF strategy only) */
  layout?: LayoutResult;
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

  /** Image bytes by asset id and update time, so repeated previews don't re-read the asset storage. */
  private imageCache = new Map<string, PdfImage | undefined>();

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
      const validation = await this.validate(ctx, invoice, files);
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
        invoice.validation = validation;
        const saved = await this.connection.getRepository(txCtx, EInvoice).save(invoice);
        await this.eventBus.publish(new EInvoiceIssuedEvent(txCtx, saved));
        return saved;
      });
      Logger.info(`Issued e-invoice ${issued.number}`, loggerCtx);
      return issued;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const validation = e instanceof ValidationFailedError ? e.summary : invoice.validation;
      await repo.update({ id: invoice.id }, { status: 'FAILED', errorMessage: message, validation });
      Object.assign(invoice, { status: 'FAILED', errorMessage: message, validation });
      Logger.error(`Rendering e-invoice ${invoice.number} failed: ${message}`, loggerCtx);
      await this.eventBus.publish(new EInvoiceFailedEvent(ctx, invoice, message));
      throw e;
    }
  }

  /**
   * Runs the configured validator on every file (unless `validation.mode` is `'off'`). In `'enforce'` mode a
   * rejected document or a failing validator throws {@link ValidationFailedError}.
   */
  private async validate(ctx: RequestContext, invoice: EInvoice, files: RenderedFile[]): Promise<ValidationSummary | null> {
    const { mode, validator } = this.options.validation;
    if (mode === 'off') return null;
    const summary: ValidationSummary = { mode, validatedAt: new Date().toISOString(), valid: true, results: [] };
    try {
      for (const file of files) {
        const report = await validator.validate(ctx, { format: file.format, fileName: file.fileName, data: file.data, xml: file.xml });
        const layoutWarnings = (file.warnings ?? []).map((w) => ({ level: 'warning' as const, code: w.code, text: w.text }));
        summary.results.push({
          format: file.format,
          valid: report.valid,
          validator: report.validator,
          messages: [...layoutWarnings, ...report.messages].slice(0, MAX_MESSAGES),
        });
        summary.valid &&= report.valid;
      }
    } catch (e) {
      summary.valid = false;
      summary.error = e instanceof Error ? e.message : String(e);
    }
    if (!summary.valid) {
      const what = summary.error ? `could not be validated: ${summary.error}` : 'was rejected by the validator';
      Logger.warn(`E-invoice ${invoice.number} ${what}`, loggerCtx);
      if (mode === 'enforce') throw new ValidationFailedError(summary);
    }
    return summary;
  }

  async renderFiles(ctx: RequestContext, model: EInvoiceModel, formats: EInvoiceFormat[]): Promise<RenderedFile[]> {
    const base = fileBaseName(model.number);
    const files: RenderedFile[] = [];
    for (const format of formats) {
      switch (format) {
        case 'zugferd': {
          const pdf = await this.renderPdfDetailed(ctx, model);
          const warnings = (pdf.layout?.issues ?? []).filter((i) => i.code === 'LAYOUT_OVERFLOW').map((i) => ({ code: i.code, text: i.message }));
          for (const w of warnings) Logger.warn(`E-invoice ${model.number}: ${w.text}`, loggerCtx);
          files.push({ format, fileName: `${base}.pdf`, mimeType: 'application/pdf', data: pdf.pdf, xml: toCii(model, 'zugferd'), warnings });
          break;
        }
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
  async renderPdf(ctx: RequestContext, model: EInvoiceModel, options?: RenderPdfOptions): Promise<Buffer> {
    return (await this.renderPdfDetailed(ctx, model, options)).pdf;
  }

  /** {@link renderPdf} with the page count, resource problems and the measured layout (for the preview). */
  async renderPdfDetailed(ctx: RequestContext, model: EInvoiceModel, options: RenderPdfOptions = {}): Promise<RenderedPdf> {
    let layout = options.layout ?? (await this.settings.get(ctx)).layout;
    const issues: RenderedPdf['issues'] = [];
    const fontNames = Object.keys(this.options.pdf.fonts ?? defaultFonts());
    if (layout.theme.font && !fontNames.includes(layout.theme.font)) {
      // e.g. the font was removed from pdf.fonts after the layout was saved: render with the default font
      const message = `The layout font "${layout.theme.font}" is not configured in pdf.fonts; using ${fontNames[0]}`;
      Logger.warn(message, loggerCtx);
      issues.push({ code: 'UNKNOWN_FONT', message, path: 'layout.theme.font' });
      layout = { ...layout, theme: { ...layout.theme, font: undefined } };
    }
    let measured: LayoutResult | undefined;
    const input = await this.templateInput(ctx, model, layout, options.enforceLogoLimit ? issues : undefined);
    input.onLayout = (result) => (measured = result);
    const definition = await this.options.pdfStrategy.buildDocDefinition(ctx, input);
    const pdf = await renderZugferdPdf({
      model,
      xml: toCii(model, 'zugferd'),
      definition,
      title: `${model.type === 'credit_note' ? input.labels.creditNote : input.labels.invoice} ${model.number}`,
      fonts: this.options.pdf.fonts,
    });
    return { pdf, pageCount: measured?.measurement.pageCount ?? countPages(pdf), issues, layout: measured };
  }

  /** What a PDF strategy gets: model, labels, layout, logo and the images of image blocks. */
  async templateInput(ctx: RequestContext, model: EInvoiceModel, layout: LayoutSettings, issues?: RenderedPdf['issues']): Promise<PdfTemplateInput> {
    const images: Record<string, PdfImage> = {};
    for (const block of layout.blocks.filter((b) => b.visible && b.type === 'image' && b.props?.assetId !== undefined)) {
      const id = String(block.props!.assetId);
      const image = await this.loadImage(ctx, id, 'layout.blocks', issues);
      if (image) images[id] = image;
    }
    return {
      model,
      labels: pdfLabels(model.language, this.options.pdf.translations),
      layout,
      logo: layout.logoAssetId ? await this.loadImage(ctx, layout.logoAssetId, 'layout.logoAssetId', issues) : undefined,
      images,
      fonts: this.options.pdf.fonts ?? defaultFonts(),
    };
  }

  /**
   * Reads an image asset from the asset storage. PNG and JPEG are embedded as images, SVG as vector graphic.
   * With `issues`, images above {@link MAX_LOGO_BYTES} are skipped and reported there.
   */
  private async loadImage(ctx: RequestContext, assetId: ID, path: string, issues?: RenderedPdf['issues']): Promise<PdfImage | undefined> {
    // Only assets of the current channel, like the asset picker shows them
    const asset = await this.connection.getRepository(ctx, Asset).findOne({ where: { id: assetId, channels: { id: ctx.channelId } } });
    const report = (code: string, message: string) => {
      issues?.push({ code, message, path });
      Logger.warn(message, loggerCtx);
    };
    if (!asset) {
      report('LOGO_NOT_FOUND', `Image asset ${assetId} not found; rendering without it`);
      return undefined;
    }
    if (issues && asset.fileSize > MAX_LOGO_BYTES) {
      report('LOGO_TOO_LARGE', `The image "${asset.name}" is larger than ${MAX_LOGO_BYTES / 1024 / 1024} MB; use a smaller one`);
      return undefined;
    }
    const key = `${asset.id}:${asset.updatedAt?.getTime?.() ?? ''}:${asset.source}`;
    if (this.imageCache.has(key)) {
      const cached = this.imageCache.get(key);
      // Refresh the LRU position
      this.imageCache.delete(key);
      this.imageCache.set(key, cached);
      return cached;
    }
    const data = await this.configService.assetOptions.assetStorageStrategy.readFileToBuffer(asset.source);
    let image: PdfImage;
    if (asset.mimeType === 'image/png' || asset.mimeType === 'image/jpeg') {
      image = { dataUrl: `data:${asset.mimeType};base64,${data.toString('base64')}` };
    } else if (asset.mimeType === 'image/svg+xml') {
      image = { svg: data.toString('utf8') };
    } else {
      report('LOGO_UNSUPPORTED_TYPE', `Image asset ${assetId} has unsupported type ${asset.mimeType} (use PNG, JPEG or SVG)`);
      return undefined;
    }
    this.imageCache.set(key, image);
    if (this.imageCache.size > IMAGE_CACHE_SIZE) this.imageCache.delete(this.imageCache.keys().next().value as string);
    return image;
  }
}

/** Number of pages of a PDF produced by pdfkit (page objects are written uncompressed). */
export function countPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
}

/** File names are derived from the invoice number; characters that are unsafe in file names are replaced. */
export function fileBaseName(number: string): string {
  return number.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function xmlFile(format: EInvoiceFormat, fileName: string, content: string): RenderedFile {
  return { format, fileName, mimeType: 'application/xml', data: Buffer.from(content, 'utf8'), xml: content };
}
