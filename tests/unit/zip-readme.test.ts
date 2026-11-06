import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildZipBlob } from '../../src/services/export/zipArchive';
describe('legacy ZIP README integrity', () => {
  it('preserves the actual README instead of overwriting it with generated instructions', async () => {
    const blob = await buildZipBlob([{ path: 'README.md', content: '# Original\r\nPokyny 🐎' }], 'replacement');
    const reader = new FileReader(), bytes = new Promise<ArrayBuffer>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject;
    });
    reader.readAsArrayBuffer(blob);
    const zip = await JSZip.loadAsync(await bytes, { checkCRC32: true });
    expect(await zip.file('README.md')!.async('string')).toBe('# Original\r\nPokyny 🐎');
  });
});
