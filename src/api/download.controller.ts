import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { Channel, ID, Logger, RequestContext, RequestContextService, TransactionalConnection } from '@vendure/core';
import { createHash } from 'crypto';
import type { Response } from 'express';
import { zipSync } from 'fflate';
import { In } from 'typeorm';

import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { EInvoiceFormat } from '../core';
import { EInvoice, EInvoiceFile } from '../entities';
import { ResolvedEInvoicePluginOptions } from '../options';
import { DOWNLOAD_ROUTE, DownloadLinkService, SignedPayload } from '../services/download-link.service';

/** Upper bound for one ZIP download. */
const MAX_ZIP_INVOICES = 500;
const FORMATS: EInvoiceFormat[] = ['zugferd', 'xrechnung-cii', 'xrechnung-ubl'];

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Downloads via signed links (see {@link DownloadLinkService}). No auth headers needed; the signature is
 * the authorization. Only files of ISSUED documents can be downloaded.
 */
@Controller(DOWNLOAD_ROUTE)
export class EInvoiceDownloadController {
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private links: DownloadLinkService,
    private requestContextService: RequestContextService,
  ) {}

  @Get('download/:id')
  async download(
    @Param('id') id: string,
    @Query() query: { f?: string; exp?: string; sig?: string },
    @Res() res: Response,
  ) {
    await this.respond(res, async () => {
      const format = query.f as EInvoiceFormat | undefined;
      if (format !== undefined && !FORMATS.includes(format)) throw new HttpError(400, 'Unknown format');
      const [invoice] = await this.loadIssued([id]);
      const ctx = await this.authorize(invoice.channelId, { kind: 'file', invoiceId: invoice.id, format }, query);
      const file = format ? invoice.files.find((f) => f.format === format) : sortFiles(invoice.files)[0];
      if (!file) throw new HttpError(404, 'File not found');
      const data = await this.read(ctx, file);
      return { data, fileName: file.fileName, mimeType: file.mimeType };
    });
  }

  @Get('zip')
  async zip(@Query() query: { ids?: string; exp?: string; sig?: string }, @Res() res: Response) {
    await this.respond(res, async () => {
      const ids = (query.ids ?? '').split(',').filter(Boolean);
      if (!ids.length || ids.length > MAX_ZIP_INVOICES) throw new HttpError(400, `Between 1 and ${MAX_ZIP_INVOICES} invoices`);
      const invoices = await this.loadIssued(ids);
      const channelId = invoices[0].channelId;
      if (invoices.some((i) => String(i.channelId) !== String(channelId))) throw new HttpError(403, 'Invalid signature');
      const ctx = await this.authorize(channelId, { kind: 'zip', invoiceIds: ids }, query);
      const entries: Record<string, Uint8Array> = {};
      for (const invoice of invoices) {
        for (const file of sortFiles(invoice.files)) entries[file.fileName] = await this.read(ctx, file);
      }
      const date = new Date().toISOString().slice(0, 10);
      return { data: Buffer.from(zipSync(entries, { level: 6 })), fileName: `e-invoices-${date}.zip`, mimeType: 'application/zip' };
    });
  }

  private async respond(res: Response, produce: () => Promise<{ data: Buffer; fileName: string; mimeType: string }>) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const { data, fileName, mimeType } = await produce();
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', String(data.length));
      res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_')}"`);
      res.status(200).end(data);
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).type('text/plain').send(e.message);
        return;
      }
      Logger.error(`Download failed: ${e instanceof Error ? e.message : String(e)}`, loggerCtx);
      res.status(500).type('text/plain').send('Download failed');
    }
  }

  /** Loads the documents in the order of the IDs; unknown and not yet issued documents are a 404. */
  private async loadIssued(ids: ID[]): Promise<EInvoice[]> {
    const invoices = await this.connection.rawConnection
      .getRepository(EInvoice)
      .find({ where: { id: In(ids), status: 'ISSUED' }, relations: ['files'] });
    const byId = new Map(invoices.map((i) => [String(i.id), i]));
    const ordered = ids.map((id) => byId.get(String(id)));
    if (ordered.some((i) => !i)) throw new HttpError(404, 'Not found');
    return ordered as EInvoice[];
  }

  private async authorize(channelId: ID, payload: SignedPayload, query: { exp?: string; sig?: string }): Promise<RequestContext> {
    const channel = await this.connection.rawConnection.getRepository(Channel).findOne({ where: { id: channelId } });
    if (!channel) throw new HttpError(404, 'Not found');
    const result = this.links.verify(payload, Number(query.exp), query.sig ?? '', channel.token);
    if (result === 'invalid') throw new HttpError(403, 'Invalid signature');
    if (result === 'expired') throw new HttpError(410, 'This link has expired. Please request a new one.');
    return this.requestContextService.create({ apiType: 'admin', channelOrToken: channel });
  }

  /** Reads a stored file and checks it against the hash recorded at issue time. */
  private async read(ctx: RequestContext, file: EInvoiceFile): Promise<Buffer> {
    const data = await this.options.storage.read(ctx, file.storageId);
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) {
      Logger.error(`Stored file ${file.fileName} does not match its SHA-256 hash`, loggerCtx);
      throw new Error(`Integrity check failed for ${file.fileName}`);
    }
    return data;
  }
}

/** PDF first, then the XML files. */
function sortFiles(files: EInvoiceFile[]): EInvoiceFile[] {
  return [...files].sort((a, b) => FORMATS.indexOf(a.format) - FORMATS.indexOf(b.format));
}
