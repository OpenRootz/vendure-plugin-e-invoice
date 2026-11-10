/**
 * Minimal XML builder: builds an element tree and serializes it with stable indentation.
 * Children that are `undefined`, `null` or `false` are skipped, so optional elements can be written inline:
 *
 *   el('ram:Name', {}, seller.name),
 *   seller.vatId && el('ram:ID', { schemeID: 'VA' }, seller.vatId),
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string | undefined>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;
export type XmlChild = XmlNode | XmlChild[] | undefined | null | false | '';

export function el(name: string, attrs: Record<string, string | undefined> = {}, ...children: XmlChild[]): XmlElement {
  return { name, attrs, children: flatten(children) };
}

/** Like {@link el}, but returns `undefined` when the element would be empty (no text, no child elements). */
export function optEl(name: string, attrs: Record<string, string | undefined> = {}, ...children: XmlChild[]): XmlElement | undefined {
  const element = el(name, attrs, ...children);
  return element.children.length ? element : undefined;
}

/** A text-only element, or `undefined` if the value is empty. */
export function textEl(
  name: string,
  value: string | undefined | null,
  attrs: Record<string, string | undefined> = {},
): XmlElement | undefined {
  return value === undefined || value === null || value === '' ? undefined : el(name, attrs, value);
}

function flatten(children: XmlChild[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of children) {
    if (child === undefined || child === null || child === false || child === '') continue;
    if (Array.isArray(child)) out.push(...flatten(child));
    else out.push(child);
  }
  return out;
}

// XML 1.0 forbids most control characters, even escaped
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeText(value: string): string {
  return value.replace(INVALID_XML_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

export function serialize(root: XmlElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(root, 0)}\n`;
}

function render(node: XmlElement, depth: number): string {
  const indent = '  '.repeat(depth);
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeAttr(v as string)}"`)
    .join('');
  if (node.children.length === 0) {
    return `${indent}<${node.name}${attrs}/>`;
  }
  if (node.children.every((c) => typeof c === 'string')) {
    return `${indent}<${node.name}${attrs}>${escapeText((node.children as string[]).join(''))}</${node.name}>`;
  }
  if (node.children.some((c) => typeof c === 'string')) {
    throw new Error(`Mixed content is not supported (<${node.name}>)`);
  }
  const inner = (node.children as XmlElement[]).map((c) => render(c, depth + 1)).join('\n');
  return `${indent}<${node.name}${attrs}>\n${inner}\n${indent}</${node.name}>`;
}
