import { RequestContext } from '@vendure/core';

import { InvoiceValidator, ValidationInput, ValidationMessage, ValidationReport } from './types';

/** Accepts everything. The default; runtime validation is off unless `validation.mode` is set. */
export class NoopValidator implements InvoiceValidator {
  async validate(): Promise<ValidationReport> {
    return { valid: true, messages: [], validator: 'none' };
  }
}

export interface KositHttpValidatorOptions {
  /** URL of the KoSIT validator in daemon mode, e.g. `http://kosit:8080/` */
  url: string;
  /** Default: 30 seconds */
  timeoutMs?: number;
  /** Extra request headers, e.g. for authentication at a proxy */
  headers?: Record<string, string>;
}

/**
 * Validates the XML with the [KoSIT validator](https://github.com/itplr-kosit/validator) in daemon mode
 * (`java -jar validator-standalone.jar -s scenarios.xml -r <config> -D -H 0.0.0.0 -P 8080`) with the
 * XRechnung configuration, which also covers plain EN 16931 (ZUGFeRD) documents.
 *
 * The daemon answers `200` for acceptable and `406` for rejected documents, with the report XML as body.
 */
export class KositHttpValidator implements InvoiceValidator {
  constructor(private options: KositHttpValidatorOptions) {
    if (!options?.url) throw new Error('KositHttpValidator: `url` is required');
  }

  async validate(_ctx: RequestContext, input: ValidationInput): Promise<ValidationReport> {
    const res = await fetch(this.options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml', ...this.options.headers },
      body: input.xml,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    const body = await res.text();
    if (res.status !== 200 && res.status !== 406) {
      throw new Error(`KoSIT validator answered ${res.status} for ${input.fileName}: ${body.slice(0, 200)}`);
    }
    return parseKositReport(body, res.status === 200);
  }
}

/** Reads the verdict and the messages from a KoSIT (VARL) report. */
export function parseKositReport(report: string, acceptedByStatus?: boolean): ValidationReport {
  const reject = /<rep:assessment>\s*<rep:reject\b/.test(report);
  const accept = /<rep:assessment>\s*<rep:accept\b/.test(report);
  const messages: ValidationMessage[] = [];
  for (const m of report.matchAll(/<rep:message\b([^>]*)>([\s\S]*?)<\/rep:message>/g)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1];
    const level = attr('level');
    messages.push({
      level: level === 'error' || level === 'warning' ? level : 'information',
      code: attr('code') ? unescape(attr('code') as string) : undefined,
      text: unescape(m[2].trim()),
      location: attr('xpathLocation') ? unescape(attr('xpathLocation') as string) : undefined,
    });
  }
  const engine = /<rep:engine>\s*<rep:name>([^<]*)<\/rep:name>/.exec(report)?.[1] ?? 'KoSIT Validator';
  return { valid: reject ? false : accept ? true : (acceptedByStatus ?? false), messages, validator: engine };
}

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
