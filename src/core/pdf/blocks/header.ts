import { fill } from '../i18n';
import { DETAIL_FIELDS, DetailField } from '../layout';

import { addressLines, BlockRenderer, GREY, PdfImage, PdfNode } from './context';

const imageNode = (image: PdfImage, width: number, height: number, align: string): PdfNode =>
  'dataUrl' in image
    ? { image: image.dataUrl, fit: [width, height], alignment: align }
    : { svg: image.svg, fit: [width, height], alignment: align };

/** The shop logo, scaled to fit the frame. */
export const logo: BlockRenderer = ({ logo, width, height, block }) =>
  logo ? imageNode(logo, width, height, block.style?.align ?? 'right') : null;

/** An image asset (`props.assetId`), scaled to fit the frame. */
export const image: BlockRenderer = ({ images, block, width, height }) => {
  const id = block.props?.assetId;
  const img = id !== undefined ? images[String(id)] : undefined;
  return img ? imageNode(img, width, height, block.style?.align ?? 'left') : null;
};

/** Small return address line above the recipient (DIN 5008 "Rücksendeangabe"). */
export const senderLine: BlockRenderer = ({ model }) => {
  const s = model.seller;
  return { text: [s.name, s.address.line1, `${s.address.postalCode} ${s.address.city}`].join(' · ') };
};

export const recipient: BlockRenderer = ({ model, labels }) => {
  const { buyer } = model;
  return { stack: addressLines(buyer.name, buyer.address, buyer.contact?.name, model.seller.address.countryCode, labels) };
};

const DEFAULT_DETAIL_FIELDS: DetailField[] = DETAIL_FIELDS.filter((f) => f !== 'sellerTaxId');

/** Invoice number, dates and references as a two-column table; rows without a value are left out. */
export const details: BlockRenderer = ({ model, labels, f, block }) => {
  const { buyer, seller } = model;
  const isCredit = model.type === 'credit_note';
  const rows: Record<DetailField, [string, string | undefined]> = {
    number: [isCredit ? labels.creditNoteNumber : labels.invoiceNumber, model.number],
    issueDate: [labels.invoiceDate, f.date(model.issueDate)],
    deliveryDate: [labels.deliveryDate, model.deliveryDate ? f.date(model.deliveryDate) : undefined],
    orderNumber: [labels.orderNumber, model.salesOrderReference],
    purchaseOrder: [labels.purchaseOrder, model.orderReference],
    buyerReference: [labels.buyerReference, model.buyerReference !== model.salesOrderReference ? model.buyerReference : undefined],
    buyerVatId: [labels.buyerVatId, buyer.vatId],
    sellerTaxId: seller.vatId ? [labels.vatId, seller.vatId] : [labels.taxNumber, seller.taxNumber],
  };
  const fields = Array.isArray(block.props?.fields) ? (block.props.fields as DetailField[]) : DEFAULT_DETAIL_FIELDS;
  const body = fields
    .map((k) => rows[k])
    .filter(([, v]) => v)
    .map(([k, v]) => [
      { text: k, color: GREY },
      { text: v, alignment: 'right' },
    ]);
  return body.length ? { table: { widths: ['auto', '*'], body }, layout: 'noBorders' } : null;
};

/** "Rechnung RE-…" and, for credit notes, the reference to the corrected invoice. */
export const title: BlockRenderer = ({ model, labels, f, accent }) => {
  const isCredit = model.type === 'credit_note';
  return {
    stack: [
      {
        text: `${isCredit ? labels.creditNote : labels.invoice} ${model.number}`,
        fontSize: 16,
        bold: true,
        color: accent,
        margin: [0, 0, 0, 4],
      },
      ...model.precedingInvoices.map((p) => ({
        text: fill(labels.correctsInvoice, { number: p.number, date: f.date(p.issueDate) }),
        margin: [0, 0, 0, 4],
      })),
    ],
  };
};

export const deliveryAddress: BlockRenderer = ({ model, labels }) =>
  model.delivery
    ? {
        stack: [
          { text: labels.deliveryAddress, fontSize: 7, color: GREY },
          {
            text: addressLines(model.delivery.name ?? '', model.delivery.address, undefined, model.seller.address.countryCode, labels).join(
              ', ',
            ),
          },
        ],
      }
    : null;
