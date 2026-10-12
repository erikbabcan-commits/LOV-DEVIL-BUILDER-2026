import { describe, it, expect } from 'vitest';
import { esc, hl, uid } from '../../src/lib/utils';

describe('utils', () => {
  it('esc escapuje &, <, >', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a&b')).toBe('a&amp;b');
  });
  it('uid: 7 znakov, unikátne', () => {
    const a = uid(); const b = uid();
    expect(a).toHaveLength(7);
    expect(a).not.toBe(b);
  });
  it('hl zvýrazní tagy', () => {
    expect(hl('<div>')).toContain('tok-tag');
  });
});
