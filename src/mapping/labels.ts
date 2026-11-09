/** Texts the mapper writes into the invoice (allowance/charge reasons). */
export interface MappingLabels {
  discount: string;
  rounding: string;
  shipping: string;
  surcharge: string;
}

const LABELS: Record<string, MappingLabels> = {
  de: { discount: 'Rabatt', rounding: 'Rundungsdifferenz', shipping: 'Versand', surcharge: 'Zuschlag' },
  en: { discount: 'Discount', rounding: 'Rounding difference', shipping: 'Shipping', surcharge: 'Surcharge' },
};

export function mappingLabels(language: string): MappingLabels {
  return LABELS[language.split(/[-_]/)[0]] ?? LABELS.en;
}
