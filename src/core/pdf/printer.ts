/**
 * Adapter for pdfmake's server-side printer.
 *
 * This is the only file that touches pdfmake internals (`pdfmake/js/*`). We need the internal printer because
 * it returns the pdfkit document *before* it is finalized, so the Factur-X XMP can still be appended.
 * pdfmake is pinned to `~0.3.14`; `test/unit/core/pdf.spec.ts` fails if these internals change.
 */
import path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const PdfPrinter = require('pdfmake/js/Printer').default;
const URLResolver = require('pdfmake/js/URLResolver').default;
const vfs = require('pdfmake/js/virtual-fs');
/* eslint-enable @typescript-eslint/no-require-imports */

/** Font files (TTF paths) per style, as pdfmake expects them. */
export interface PdfFontFiles {
  normal: string;
  bold: string;
  italics: string;
  bolditalics: string;
}
export type PdfFonts = Record<string, PdfFontFiles>;

/** A pdfmake document definition (https://pdfmake.github.io/docs/). Typed loosely on purpose. */
export interface PdfDocDefinition {
  content: unknown;
  styles?: Record<string, unknown>;
  defaultStyle?: Record<string, unknown>;
  pageSize?: unknown;
  pageMargins?: unknown;
  header?: unknown;
  footer?: unknown;
  images?: Record<string, string>;
  [key: string]: unknown;
}

/** The minimal pdfkit API we use on the returned document. */
export interface PdfKitDocument {
  appendXML(xml: string): void;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end' | 'error', cb: (arg?: unknown) => void): void;
  end(): void;
}

export function defaultFonts(): PdfFonts {
  const dir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts/Roboto');
  return {
    Roboto: {
      normal: path.join(dir, 'Roboto-Regular.ttf'),
      bold: path.join(dir, 'Roboto-Medium.ttf'),
      italics: path.join(dir, 'Roboto-Italic.ttf'),
      bolditalics: path.join(dir, 'Roboto-MediumItalic.ttf'),
    },
  };
}

/**
 * Lays out the document and returns the (not yet finalized) pdfkit document.
 * Remote URLs are never fetched, and only the font files may be read from disk; images must be data URLs.
 */
export async function createPdfKitDocument(definition: PdfDocDefinition, fonts: PdfFonts): Promise<PdfKitDocument> {
  const fontFiles = new Set(Object.values(fonts).flatMap((f) => [f.normal, f.bold, f.italics, f.bolditalics].map((p) => path.resolve(p))));
  const docVfs = new vfs.VirtualFileSystem(vfs.default);
  const urlResolver = new URLResolver(docVfs, vfs.default);
  urlResolver.setUrlAccessPolicy(() => false);
  const localAccess = (p: string) => fontFiles.has(path.resolve(p));
  const printer = new PdfPrinter(fonts, docVfs, urlResolver, localAccess);
  return printer.createPdfKitDocument(definition);
}

export function finalize(doc: PdfKitDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
