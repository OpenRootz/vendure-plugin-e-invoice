import { describe, expect, it } from 'vitest';

import { zipEntryName } from '../../src/api/download.controller';

describe('zipEntryName', () => {
  it('keeps free names and numbers taken ones', () => {
    const entries: Record<string, unknown> = { 'RE-1.pdf': 1, 'RE-1 (2).pdf': 1, README: 1 };
    expect(zipEntryName(entries, 'RE-2.pdf')).toBe('RE-2.pdf');
    expect(zipEntryName(entries, 'RE-1.pdf')).toBe('RE-1 (3).pdf');
    expect(zipEntryName(entries, 'README')).toBe('README (2)');
  });
});
