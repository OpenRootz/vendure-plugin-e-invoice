import { describe, expect, it } from 'vitest';

import { RequestContext } from '@vendure/core';

import { parseDuration, resolveOptions } from '../../src/options';
import { DownloadLinkService } from '../../src/services/download-link.service';
import { EmailPluginDeliveryStrategy } from '../../src/strategies/email-plugin-delivery-strategy';

describe('resolveOptions', () => {
  it('rejects a missing or short secret', () => {
    expect(() => resolveOptions({ secret: '' })).toThrow(/secret/);
    expect(() => resolveOptions({ secret: 'short' })).toThrow(/secret/);
  });

  it('applies defaults', () => {
    const o = resolveOptions({ secret: 'x'.repeat(32) });
    expect(o.issueOnStates).toEqual(['PaymentSettled']);
    expect(o.autoCreditNotes).toBe(true);
    expect(o.taxCalculation).toBe('vendure');
  });
});

describe('download link options', () => {
  it('parses durations', () => {
    expect(parseDuration(90)).toBe(90);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('7d')).toBe(604800);
    expect(() => parseDuration('7 days' as never)).toThrow(/positive number/);
    expect(() => parseDuration(0)).toThrow(/positive number/);
  });

  it('rejects a base URL that is not a plain http(s) URL', () => {
    for (const baseUrl of ['shop.example.com', 'javascript:alert(1)', 'https://shop.example.com/?x=1', 'https://shop.example.com#a']) {
      expect(() => resolveOptions({ secret: 'x'.repeat(32), downloadLinks: { baseUrl } })).toThrow(/baseUrl/);
    }
    expect(resolveOptions({ secret: 'x'.repeat(32), downloadLinks: { baseUrl: 'http://localhost:3000/shop' } }).downloadLinks.baseUrl).toBe(
      'http://localhost:3000/shop',
    );
  });

  it('applies defaults and trims the base URL', () => {
    const o = resolveOptions({ secret: 'x'.repeat(32), downloadLinks: { guestTtl: '2d', baseUrl: 'https://shop.example.com/' } });
    expect(o.downloadLinks).toEqual({ guestTtl: 172800, ownerTtl: 3600, adminTtl: 900, baseUrl: 'https://shop.example.com' });
  });
});

describe('DownloadLinkService', () => {
  const options = resolveOptions({ secret: 'x'.repeat(32), downloadLinks: { baseUrl: 'https://shop.example.com' } });
  const links = new DownloadLinkService(options);
  const ctx = { channel: { token: 'channel-a' } } as RequestContext;
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it('signs file links that verify only for the same invoice, format and channel', () => {
    const url = links.fileLink(ctx, { id: 7 }, 'zugferd', 'guest');
    expect(url).toMatch(/^https:\/\/shop\.example\.com\/e-invoice\/download\/7\?f=zugferd&exp=\d+&sig=/);
    const { exp, sig } = params(url);
    const payload = { kind: 'file', invoiceId: 7, format: 'zugferd' } as const;
    expect(links.verify(payload, Number(exp), sig, 'channel-a')).toBe('valid');
    expect(links.verify({ ...payload, invoiceId: 8 }, Number(exp), sig, 'channel-a')).toBe('invalid');
    expect(links.verify({ ...payload, format: 'xrechnung-cii' }, Number(exp), sig, 'channel-a')).toBe('invalid');
    expect(links.verify(payload, Number(exp) + 1, sig, 'channel-a')).toBe('invalid');
    expect(links.verify(payload, Number(exp), sig, 'channel-b')).toBe('invalid');
    expect(links.verify(payload, Number(exp), sig.slice(1), 'channel-a')).toBe('invalid');
    // guest links live 7 days
    expect(Number(exp) - Date.now() / 1000).toBeGreaterThan(604800 - 5);
    expect(links.verify(payload, Number(exp), sig, 'channel-a', (Number(exp) + 1) * 1000)).toBe('expired');
  });

  it('signs zip links over the list of invoices', () => {
    const { exp, sig, ids } = params(links.zipLink(ctx, [1, 2]));
    expect(ids).toBe('1,2');
    expect(links.verify({ kind: 'zip', invoiceIds: ['1', '2'] }, Number(exp), sig, 'channel-a')).toBe('valid');
    expect(links.verify({ kind: 'zip', invoiceIds: ['1', '2', '3'] }, Number(exp), sig, 'channel-a')).toBe('invalid');
  });

  it('needs a base URL outside of requests', () => {
    const noBase = new DownloadLinkService(resolveOptions({ secret: 'x'.repeat(32) }));
    expect(() => noBase.fileLink(ctx, { id: 1 })).toThrow(/baseUrl/);
  });

  it('builds guest links from the Host header only in the Admin API', () => {
    const noBase = new DownloadLinkService(resolveOptions({ secret: 'x'.repeat(32) }));
    const req = { protocol: 'https', get: () => 'attacker.example' };
    const shop = { ...ctx, apiType: 'shop', req } as unknown as RequestContext;
    const admin = { ...ctx, apiType: 'admin', req } as unknown as RequestContext;
    expect(() => noBase.fileLink(shop, { id: 1 }, 'zugferd', 'guest')).toThrow(/baseUrl/);
    // The customer's own link goes back to the client that sent the header
    expect(noBase.fileLink(shop, { id: 1 }, 'zugferd', 'owner')).toMatch(/^https:\/\/attacker\.example\//);
    expect(noBase.fileLink(admin, { id: 1 }, 'zugferd', 'guest')).toMatch(/^https:\/\/attacker\.example\//);
  });
});

describe('delivery options', () => {
  const secret = 'x'.repeat(32);

  it('applies defaults', () => {
    const { delivery } = resolveOptions({ secret });
    expect(delivery.strategy).toBeInstanceOf(EmailPluginDeliveryStrategy);
    expect(delivery.autoSend).toEqual({ invoices: true, creditNotes: ['refund', 'cancellation', 'modification', 'reissue', 'manual'] });
    expect(delivery.maxAttachmentBytes).toBe(5 * 1024 * 1024);
    expect(delivery.requestLimit).toEqual({ max: 3, window: 3600 });
  });

  it('takes credit note reasons, true or false', () => {
    expect(resolveOptions({ secret, delivery: { autoSend: { creditNotes: false } } }).delivery.autoSend.creditNotes).toEqual([]);
    expect(resolveOptions({ secret, delivery: { autoSend: { creditNotes: ['refund'] } } }).delivery.autoSend.creditNotes).toEqual([
      'refund',
    ]);
    expect(resolveOptions({ secret, delivery: { autoSend: { invoices: false } } }).delivery.autoSend.invoices).toBe(false);
  });

  it('rejects invalid limits', () => {
    expect(() => resolveOptions({ secret, delivery: { maxAttachmentBytes: -1 } })).toThrow(/maxAttachmentBytes/);
    expect(() => resolveOptions({ secret, delivery: { requestLimit: { max: 1.5 } } })).toThrow(/requestLimit.max/);
    expect(() => resolveOptions({ secret, delivery: { requestLimit: { window: '1 hour' as never } } })).toThrow(/requestLimit.window/);
    expect(resolveOptions({ secret, delivery: { requestLimit: { max: 0, window: '1d' } } }).delivery.requestLimit).toEqual({
      max: 0,
      window: 86400,
    });
  });
});
