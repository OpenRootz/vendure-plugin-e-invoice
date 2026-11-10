import type { BlockType } from '../layout';

import { closingText, customText, exemptionNotes, introText, lines, notes, payment, totals } from './content';
import { BlockRenderer } from './context';
import { footer, pageNumber } from './footer';
import { deliveryAddress, details, image, logo, recipient, senderLine, title } from './header';

export * from './context';
export { exemptionTexts } from './content';

/** The renderer of every block type. A custom `InvoicePdfStrategy` can reuse them. */
export const blockRenderers: Record<BlockType, BlockRenderer> = {
  logo,
  senderLine,
  recipient,
  details,
  title,
  deliveryAddress,
  introText,
  lines,
  totals,
  exemptionNotes,
  notes,
  payment,
  closingText,
  footer,
  pageNumber,
  customText,
  image,
};
