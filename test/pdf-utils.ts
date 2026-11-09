import { inflateSync } from 'zlib';

/** Extracts the embedded `factur-x.xml` from a ZUGFeRD PDF rendered by the plugin (FlateDecode stream). */
export function extractFacturX(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const obj = raw.indexOf('/Type /EmbeddedFile');
  if (obj < 0) throw new Error('No embedded file found');
  const start = raw.indexOf('stream\n', obj) + 'stream\n'.length;
  const end = raw.indexOf('\nendstream', start);
  return inflateSync(pdf.subarray(start, end)).toString('utf8');
}
