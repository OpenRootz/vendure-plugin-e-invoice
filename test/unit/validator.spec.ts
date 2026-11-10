import { RequestContext } from '@vendure/core';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KositHttpValidator, parseKositReport, ValidationInput } from '../../src';

// Shape of a real KoSIT 1.6.3 daemon answer, shortened
const ACCEPTED = `<?xml version="1.0" encoding="UTF-8"?><rep:report xmlns:rep="http://www.xoev.de/de/validator/varl/1" valid="true">
<rep:engine><rep:name>KoSIT Validator 1.6.3</rep:name></rep:engine><rep:assessment><rep:accept><rep:explanation/></rep:accept></rep:assessment></rep:report>`;

const REJECTED = `<?xml version="1.0" encoding="UTF-8"?><rep:report xmlns:rep="http://www.xoev.de/de/validator/varl/1" valid="false">
<rep:engine><rep:name>KoSIT Validator 1.6.3</rep:name></rep:engine>
<rep:validationStepResult id="val-sch.1" valid="false">
<rep:message id="val-sch.1.1" level="error" xpathLocation="/Q{urn:x}CrossIndustryInvoice[1]" code="BR-CO-16">[BR-CO-16]-Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) -Paid amount (BT-113) +Rounding amount (BT-114).</rep:message>
<rep:message id="val-sch.1.2" level="warning" code="BR-DE-21">Customization &amp; profile &lt;check&gt;</rep:message>
</rep:validationStepResult>
<rep:assessment><rep:reject><rep:explanation/></rep:reject></rep:assessment></rep:report>`;

const ctx = {} as RequestContext;
const input = (xml: string): ValidationInput => ({ format: 'xrechnung-cii', fileName: 'x.xml', data: Buffer.from(xml), xml });

describe('parseKositReport', () => {
  it('reads an accepted report', () => {
    expect(parseKositReport(ACCEPTED)).toEqual({ valid: true, messages: [], validator: 'KoSIT Validator 1.6.3' });
  });

  it('reads the verdict and messages of a rejected report', () => {
    const report = parseKositReport(REJECTED, true);
    expect(report.valid).toBe(false);
    expect(report.messages).toEqual([
      {
        level: 'error',
        code: 'BR-CO-16',
        text: expect.stringContaining('Amount due for payment (BT-115)'),
        location: '/Q{urn:x}CrossIndustryInvoice[1]',
      },
      { level: 'warning', code: 'BR-DE-21', text: 'Customization & profile <check>', location: undefined },
    ]);
  });
});

describe('KositHttpValidator', () => {
  let server: http.Server;
  let url: string;
  const received: { body: string; type?: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, type: req.headers['content-type'] });
        if (body.includes('broken')) return res.writeHead(422).end('cannot process');
        res.writeHead(body.includes('bad') ? 406 : 200, { 'Content-Type': 'application/xml' });
        res.end(body.includes('bad') ? REJECTED : ACCEPTED);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('posts the XML and returns the verdict', async () => {
    const validator = new KositHttpValidator({ url });
    expect((await validator.validate(ctx, input('<good/>'))).valid).toBe(true);
    expect(received[0]).toEqual({ body: '<good/>', type: 'application/xml' });
    const rejected = await validator.validate(ctx, input('<bad/>'));
    expect(rejected.valid).toBe(false);
    expect(rejected.messages[0].code).toBe('BR-CO-16');
  });

  it('throws when the validator cannot process the document', async () => {
    await expect(new KositHttpValidator({ url }).validate(ctx, input('<broken/>'))).rejects.toThrow(/answered 422/);
  });

  it('requires a URL', () => {
    expect(() => new KositHttpValidator({ url: '' })).toThrow(/url/);
  });
});

// Against a real KoSIT daemon, e.g.:
//   docker run -p 8080:8080 -v $PWD/.validate-tools:/tools:ro eclipse-temurin:21-jre \
//     java -jar /tools/kosit.jar -s /tools/xr/scenarios.xml -r /tools/xr -D -H 0.0.0.0 -P 8080
//   KOSIT_URL=http://localhost:8080/ pnpm test test/unit/validator.spec.ts
describe.runIf(process.env.KOSIT_URL)('KositHttpValidator with a real KoSIT daemon', () => {
  const golden = fs.readFileSync(path.join(__dirname, '../golden/credit-note-return.xrechnung-cii.xml'), 'utf8');

  it('accepts a valid XRechnung and rejects a wrong total', async () => {
    const validator = new KositHttpValidator({ url: process.env.KOSIT_URL as string });
    const ok = await validator.validate(ctx, input(golden));
    expect(ok).toMatchObject({ valid: true, validator: expect.stringContaining('KoSIT') });
    const bad = await validator.validate(ctx, input(golden.replace('<ram:DuePayableAmount>', '<ram:DuePayableAmount>9')));
    expect(bad.valid).toBe(false);
    expect(bad.messages.map((m) => m.code)).toContain('BR-CO-16');
  });
});
