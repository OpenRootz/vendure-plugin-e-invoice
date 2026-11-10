import { BlockRenderer, formatIban, LIGHT, sepaAccount, textProp } from './context';

const pageText = (labels: { page: string; of: string }, page = 1, count = 1) => `${labels.page} ${page} ${labels.of} ${count}`;

/** Seller name and address, contact, tax IDs and bank account in four columns, plus an optional text line. */
export const footer: BlockRenderer = ({ model, labels, block, width, page, pageCount }) => {
  const s = model.seller;
  const bank = sepaAccount(model);
  const col = (lines: (string | undefined)[]) => ({ width: '*', stack: lines.filter(Boolean).map((text) => ({ text })) });
  const text = textProp(block);
  return {
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.3, lineColor: LIGHT }], margin: [0, 0, 0, 4] },
      {
        columns: [
          col([s.name, s.address.line1, `${s.address.postalCode} ${s.address.city}`]),
          col([s.contact.phone && `${labels.phone} ${s.contact.phone}`, s.contact.email && `${labels.email} ${s.contact.email}`]),
          col([
            s.vatId && `${labels.vatId} ${s.vatId}`,
            s.taxNumber && `${labels.taxNumber} ${s.taxNumber}`,
            s.legalRegistration?.id,
            s.legalInfo,
          ]),
          col([bank && `IBAN ${formatIban(bank.iban)}`, bank?.bic && `BIC ${bank.bic}`]),
        ],
        columnGap: 8,
      },
      text ? { text, margin: [0, 4, 0, 0] } : '',
      block.props?.pageNumber ? { text: pageText(labels, page, pageCount), alignment: 'right', margin: [0, 4, 0, 0] } : '',
    ].filter((n) => n !== ''),
  };
};

export const pageNumber: BlockRenderer = ({ labels, page, pageCount }) => ({ text: pageText(labels, page, pageCount) });
