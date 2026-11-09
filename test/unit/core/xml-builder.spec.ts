import { describe, expect, it } from 'vitest';

import { el, escapeAttr, escapeText, optEl, serialize, textEl } from '../../../src/core';

describe('xml builder', () => {
  it('escapes text and attributes', () => {
    expect(escapeText('Müller & Söhne <GmbH>')).toBe('Müller &amp; Söhne &lt;GmbH&gt;');
    expect(escapeAttr('a"b\nc')).toBe('a&quot;b&#10;c');
  });

  it('removes characters that are invalid in XML 1.0', () => {
    expect(escapeText('Name\u0000\u0008 ok\t')).toBe('Name ok\t');
  });

  it('skips empty optional children and serializes with stable indentation', () => {
    const xml = serialize(
      el(
        'root',
        { a: 'x', b: undefined },
        textEl('empty', ''),
        textEl('name', 'A & B'),
        optEl('wrapper', {}, undefined, false),
        el('list', {}, [el('item', {}, '1'), el('item', {}, '2')]),
        el('self'),
      ),
    );
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<root a="x">',
        '  <name>A &amp; B</name>',
        '  <list>',
        '    <item>1</item>',
        '    <item>2</item>',
        '  </list>',
        '  <self/>',
        '</root>',
        '',
      ].join('\n'),
    );
  });

  it('rejects mixed content', () => {
    expect(() => serialize(el('a', {}, 'text', el('b')))).toThrow(/Mixed content/);
  });
});
