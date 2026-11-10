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
  /**
   * Set by `compileLayout`: page backgrounds that print the page count read `value`. If it is not `resolved`, the
   * document is laid out once more with the real count.
   */
  pageCountRef?: { value: number; resolved: boolean };
  [key: string]: unknown;
}

/** Where pdfmake placed a node with an `id` (pt, page coordinates; pages count from 1). */
export interface NodePosition {
  id: string;
  page: number;
  /** Pages the node spans */
  pages: number[];
  left: number;
  top: number;
}

/** Result of a layout pass: the page count and the positions of all nodes with an id. */
export interface LayoutProbe {
  pageCount: number;
  positions: NodePosition[];
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
export async function createPdfKitDocument(definition: PdfDocDefinition, fonts: PdfFonts, probe?: LayoutProbe): Promise<PdfKitDocument> {
  const ref = definition.pageCountRef;
  if (!ref || ref.resolved) return layOut(definition, fonts, probe);
  const first: LayoutProbe = { pageCount: 0, positions: [] };
  const doc = await layOut(definition, fonts, first);
  ref.resolved = true;
  if (first.pageCount === ref.value) {
    if (probe) Object.assign(probe, first);
    return doc;
  }
  ref.value = first.pageCount;
  return layOut(definition, fonts, probe);
}

/** Lays the document out once and reports the page count and node positions; the document itself is dropped. */
export async function probeLayout(definition: PdfDocDefinition, fonts: PdfFonts): Promise<LayoutProbe> {
  const probe: LayoutProbe = { pageCount: 0, positions: [] };
  await createPdfKitDocument(definition, fonts, probe);
  return probe;
}

async function layOut(definition: PdfDocDefinition, fonts: PdfFonts, probe?: LayoutProbe): Promise<PdfKitDocument> {
  if (probe) {
    probe.positions = [];
    probe.pageCount = 0;
    const own = definition.pageBreakBefore as ((...args: unknown[]) => boolean) | undefined;
    // pageBreakBefore is pdfmake's public hook that sees every laid-out node; it never forces a break here
    definition.pageBreakBefore = (
      node: { id?: unknown; startPosition?: { pageNumber: number; left: number; top: number }; pageNumbers?: number[]; pages?: number },
      ...rest: unknown[]
    ) => {
      probe.pageCount = Math.max(probe.pageCount, node.pages ?? 0);
      if (typeof node.id === 'string' && node.startPosition) {
        probe.positions.push({
          id: node.id,
          page: node.startPosition.pageNumber,
          pages: node.pageNumbers ?? [],
          left: node.startPosition.left,
          top: node.startPosition.top,
        });
      }
      return own ? own(node, ...rest) : false;
    };
    try {
      return await layOutRaw(definition, fonts);
    } finally {
      definition.pageBreakBefore = own;
    }
  }
  return layOutRaw(definition, fonts);
}

async function layOutRaw(definition: PdfDocDefinition, fonts: PdfFonts): Promise<PdfKitDocument> {
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
