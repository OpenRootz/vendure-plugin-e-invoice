import { Inject, Injectable } from '@nestjs/common';
import { ID, Logger, RequestContext } from '@vendure/core';
import { createHmac, timingSafeEqual } from 'crypto';

import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { EInvoiceFormat } from '../core';
import { EInvoice } from '../entities';
import { ResolvedEInvoicePluginOptions } from '../options';

/** Path of the download routes, relative to the server root. */
export const DOWNLOAD_ROUTE = 'e-invoice';

/** Upper bound for one ZIP download. */
export const MAX_ZIP_INVOICES = 500;

export type LinkAudience = 'guest' | 'owner' | 'admin';

export type SignedPayload = { kind: 'file'; invoiceId: ID; format?: EInvoiceFormat } | { kind: 'zip'; invoiceIds: ID[] };

export type VerifyResult = 'valid' | 'expired' | 'invalid';

/**
 * Signed, time-limited download links. The GraphQL resolvers check permissions or ownership and then mint a
 * link; the download route only verifies the signature, so plain `<a href>` downloads work without auth headers.
 *
 * `sig = HMAC-SHA256(secret, payload | exp | channel token)`: rotating the secret or the channel token
 * invalidates all links.
 */
@Injectable()
export class DownloadLinkService {
  private warnedAboutHost = false;

  constructor(@Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions) {}

  /** Link to one file of an invoice (default: its first file, usually the ZUGFeRD PDF). */
  fileLink(ctx: RequestContext, invoice: Pick<EInvoice, 'id'>, format?: EInvoiceFormat, audience: LinkAudience = 'guest') {
    const exp = this.expiry(audience);
    const sig = this.sign(ctx, { kind: 'file', invoiceId: invoice.id, format }, exp);
    const query = new URLSearchParams({ ...(format ? { f: format } : {}), exp: String(exp), sig });
    return `${this.baseUrl(ctx)}/${DOWNLOAD_ROUTE}/download/${encodeURIComponent(String(invoice.id))}?${query}`;
  }

  /** Link to a ZIP archive with all files of the given invoices. */
  zipLink(ctx: RequestContext, invoiceIds: ID[], audience: LinkAudience = 'admin') {
    const exp = this.expiry(audience);
    const sig = this.sign(ctx, { kind: 'zip', invoiceIds }, exp);
    const query = new URLSearchParams({ ids: invoiceIds.join(','), exp: String(exp), sig });
    return `${this.baseUrl(ctx)}/${DOWNLOAD_ROUTE}/zip?${query}`;
  }

  /** Checks a signature against the channel of the documents. */
  verify(payload: SignedPayload, exp: number, sig: string, channelToken: string, now = Date.now()): VerifyResult {
    if (!Number.isInteger(exp) || !sig) return 'invalid';
    const expected = Buffer.from(this.hmac(payload, exp, channelToken));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'invalid';
    return exp * 1000 < now ? 'expired' : 'valid';
  }

  sign(ctx: RequestContext, payload: SignedPayload, exp: number): string {
    return this.hmac(payload, exp, ctx.channel.token);
  }

  private hmac(payload: SignedPayload, exp: number, channelToken: string): string {
    const subject =
      payload.kind === 'file' ? `file|${payload.invoiceId}|${payload.format ?? ''}` : `zip|${payload.invoiceIds.map(String).join(',')}`;
    return createHmac('sha256', this.options.secret).update(`${subject}|${exp}|${channelToken}`).digest('base64url');
  }

  private expiry(audience: LinkAudience): number {
    const ttl = this.options.downloadLinks[`${audience}Ttl`];
    return Math.floor(Date.now() / 1000) + ttl;
  }

  private baseUrl(ctx: RequestContext): string {
    if (this.options.downloadLinks.baseUrl) return this.options.downloadLinks.baseUrl;
    const req = ctx.req;
    if (!req) throw new Error('EInvoicePlugin: set `downloadLinks.baseUrl` to create download links outside of an API request');
    if (!this.warnedAboutHost) {
      this.warnedAboutHost = true;
      Logger.warn(
        'downloadLinks.baseUrl is not set: download links use the Host header of the request. Set it in production, ' +
          'so that links (e.g. in emails) cannot point to a host chosen by the client.',
        loggerCtx,
      );
    }
    return `${req.protocol}://${req.get('host')}`;
  }
}
