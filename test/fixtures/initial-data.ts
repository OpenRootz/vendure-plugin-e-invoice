import { InitialData, LanguageCode } from '@vendure/core';

/** German shop: EUR, 19 % / 7 % / 0 % VAT, one shipping method, dummy payment. */
export const initialData: InitialData = {
  defaultLanguage: LanguageCode.de,
  defaultZone: 'Germany',
  taxRates: [
    { name: 'Standard', percentage: 19 },
    { name: 'Reduced', percentage: 7 },
    { name: 'Zero', percentage: 0 },
  ],
  shippingMethods: [{ name: 'DHL Paket', price: 490 }],
  paymentMethods: [
    {
      name: 'Test Payment',
      handler: {
        code: 'dummy-payment-handler',
        arguments: [{ name: 'automaticSettle', value: 'true' }],
      },
    },
  ],
  countries: [
    { name: 'Deutschland', code: 'DE', zone: 'Germany' },
    { name: 'Österreich', code: 'AT', zone: 'Europe' },
    { name: 'Frankreich', code: 'FR', zone: 'Europe' },
    { name: 'Schweiz', code: 'CH', zone: 'World' },
  ],
  collections: [],
};
