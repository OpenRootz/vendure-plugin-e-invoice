import { EInvoiceModel } from '../model';

import { createPdfKitDocument, defaultFonts, finalize, PdfDocDefinition, PdfFonts } from './printer';

/** File name of the embedded XML required by ZUGFeRD 2.x / Factur-X. */
export const FACTURX_FILE_NAME = 'factur-x.xml';

const FX_NS = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';

const property = (name: string, description: string) =>
  `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>${description}</pdfaProperty:description></rdf:li>`;

/** Factur-X XMP metadata plus its PDF/A extension schema description (required next to pdfkit's pdfaid block). */
const FACTURX_XMP = `
<rdf:Description rdf:about="" xmlns:fx="${FX_NS}">
  <fx:DocumentType>INVOICE</fx:DocumentType>
  <fx:DocumentFileName>${FACTURX_FILE_NAME}</fx:DocumentFileName>
  <fx:Version>1.0</fx:Version>
  <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
</rdf:Description>
<rdf:Description rdf:about=""
    xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
    xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
  <pdfaExtension:schemas>
    <rdf:Bag>
      <rdf:li rdf:parseType="Resource">
        <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
        <pdfaSchema:namespaceURI>${FX_NS}</pdfaSchema:namespaceURI>
        <pdfaSchema:prefix>fx</pdfaSchema:prefix>
        <pdfaSchema:property>
          <rdf:Seq>
            ${property('DocumentFileName', 'name of the embedded XML invoice file')}
            ${property('DocumentType', 'INVOICE')}
            ${property('Version', 'The actual version of the Factur-X XML schema')}
            ${property('ConformanceLevel', 'The conformance level of the embedded Factur-X data')}
          </rdf:Seq>
        </pdfaSchema:property>
      </rdf:li>
    </rdf:Bag>
  </pdfaExtension:schemas>
</rdf:Description>`;

/** Template keys that would break PDF/A or the ZUGFeRD structure; the plugin sets or removes them. */
const ENFORCED_KEYS = [
  'version',
  'subset',
  'tagged',
  'language',
  'info',
  'files',
  'attachments',
  'userPassword',
  'ownerPassword',
  'permissions',
  'compress',
];

export interface ZugferdPdfInput {
  model: EInvoiceModel;
  /** CII XML (ZUGFeRD flavour) to embed */
  xml: string;
  /** Layout from the template; PDF/A options, metadata and the attachment are enforced here */
  definition: PdfDocDefinition;
  /** Document title, e.g. "Rechnung RE-2026-00001" */
  title: string;
  fonts?: PdfFonts;
}

/**
 * Renders a ZUGFeRD / Factur-X PDF: PDF/A-3b with the CII XML embedded as `factur-x.xml`
 * (AFRelationship `Alternative`) and the Factur-X XMP metadata.
 *
 * Output is deterministic: all dates are the issue date, so the same input produces the same bytes.
 */
export async function renderZugferdPdf(input: ZugferdPdfInput): Promise<Buffer> {
  const fonts = input.fonts ?? defaultFonts();
  const issued = new Date(`${input.model.issueDate}T00:00:00Z`);
  const template = Object.fromEntries(Object.entries(input.definition).filter(([k]) => !ENFORCED_KEYS.includes(k)));
  const definition: PdfDocDefinition = {
    ...template,
    content: input.definition.content,
    defaultStyle: { font: Object.keys(fonts)[0], ...input.definition.defaultStyle },
    version: '1.7',
    subset: 'PDF/A-3b',
    language: input.model.language,
    info: {
      title: input.title,
      author: input.model.seller.name,
      subject: input.title,
      creator: input.model.seller.name,
      producer: input.model.seller.name,
      creationDate: issued,
      modDate: issued,
    },
    files: {
      facturx: {
        src: `data:text/xml;base64,${Buffer.from(input.xml, 'utf8').toString('base64')}`,
        name: FACTURX_FILE_NAME,
        type: 'text/xml',
        description: 'Factur-X/ZUGFeRD invoice',
        relationship: 'Alternative',
        creationDate: issued,
        modifiedDate: issued,
      },
    },
  };
  const doc = await createPdfKitDocument(definition, fonts);
  doc.appendXML(FACTURX_XMP);
  return finalize(doc);
}
