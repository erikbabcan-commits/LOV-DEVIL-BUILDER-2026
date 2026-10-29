import { describe, it, expect } from 'vitest';
import { vfsSplitBlocks, vfsJoinBlocks, withoutExternalScripts } from '../../src/lib/vfs';

describe('VFS D3d (M1.1) — faithful reconstruction over consolidation', () => {
  it('odstráni externý script zo statického preview, ale zachová inline script', () => {
    const html = '<div id="root"></div><script type="module" src="/src/main.tsx"></script><script>window.ok = true</script>';
    expect(withoutExternalScripts(html)).toBe('<div id="root"></div><script>window.ok = true</script>');
  });
  it('jeden klasický inline script → extrakcia (bežný prípad)', () => {
    const src = '<html><head><style>a{b:c}</style></head><body><h1>Ahoj</h1><script>let x = 1<\/script></body></html>';
    const r = vfsSplitBlocks(src);
    expect(r.jsParts.length).toBe(1);
    expect(r.jsParts[0].content).toContain('let x = 1');
    expect(r.cssParts.length).toBe(1);
    expect(r.indexHtml).not.toContain('let x = 1');
  });

  it('D3d: 2+ klasické inline scripty (aj adjacent) sa NESPÁJAJÚ — izolácia script kontextov', () => {
    const src = '<head><script>let x = 1<\/script><script>let x = 2<\/script></head><body>b</body>';
    const r = vfsSplitBlocks(src);
    expect(r.jsParts.length).toBe(0);
    expect(r.indexHtml).toContain('let x = 1');
    expect(r.indexHtml).toContain('let x = 2');
    expect(r.skippedScript).toBe(true);
    // roundtrip: nič sa nestratilo
    const out = vfsJoinBlocks(r.indexHtml, '', '');
    expect(out).toBe(r.indexHtml);
  });

  it('D3d: throw izolácia — scripty ostanú oddelené (blok2 beží aj keď blok1 throw)', () => {
    const src = '<body><script>throw new Error("x")<\/script><script>ok()<\/script></body>';
    const r = vfsSplitBlocks(src);
    expect(r.jsParts.length).toBe(0);
    expect(r.indexHtml).toMatch(/<script>throw[\s\S]*?<\/script><script>ok\(\)/);
  });

  it('D3d: "use strict" v jednom scripte sa nerozširuje — scripty ostanú oddelené', () => {
    const src = '<head><script>"use strict"; a()<\/script><script>b()<\/script></head>';
    const r = vfsSplitBlocks(src);
    expect(r.jsParts.length).toBe(0);
    expect(r.skippedScript).toBe(true);
  });

  it('module/JSON/src/atribútové bloky sa NEDOTÝKAJÚ', () => {
    const src = '<head>'
      + '<script src="https://cdn.example.com/lib.js"><\/script>'
      + '<script type="module">mod()<\/script>'
      + '<script type="application/json">{"d":1}<\/script>'
      + '<style media="print">p{color:red}<\/style>'
      + '<script>classic()<\/script>'
      + '</head><body>b</body>';
    const r = vfsSplitBlocks(src);
    expect(r.indexHtml).toContain('src="https://cdn.example.com/lib.js"');
    expect(r.indexHtml).toContain('type="module"');
    expect(r.indexHtml).toContain('type="application/json"');
    expect(r.indexHtml).toContain('media="print"');
    expect(r.jsParts.length).toBe(1);
    expect(r.jsParts[0].content).toContain('classic()');
  });

  it('CSS adjacent skupina sa extrahuje (kaskáda = poradie pravidiel)', () => {
    const src = '<head><style>a{color:red}<\/style><style>a{color:blue}<\/style></head><body>x</body>';
    const r = vfsSplitBlocks(src);
    expect(r.cssParts.length).toBe(2);
    const css = r.cssParts.map(p => p.content.trim()).join('\n');
    expect(css.indexOf('color:red')).toBeLessThan(css.indexOf('color:blue'));
  });

  it('D3d: ne-adjacent CSS (DOM medzi stylemi) → exact preservation', () => {
    const src = '<style>a{b:c}<\/style><p>medzi</p><style>p{color:red}<\/style>';
    const r = vfsSplitBlocks(src);
    expect(r.cssParts.length).toBe(0);
    expect(r.skippedStyle).toBe(true);
    expect(r.indexHtml).toContain('a{b:c}');
    expect(r.indexHtml).toContain('p{color:red}');
    expect(r.indexHtml).toContain('<p>medzi</p>');
  });

  it('roundtrip: extrahovaný obsah sa stratovo vráti', () => {
    const src = '<html><head><style>a{b:c}</style></head><body><h1>Ahoj</h1><script>let x = 1<\/script></body></html>';
    const r = vfsSplitBlocks(src);
    const out = vfsJoinBlocks(r.indexHtml, r.cssParts[0].content.trim(), r.jsParts[0].content.trim());
    expect(out).toContain('a{b:c}');
    expect(out).toContain('let x = 1');
    expect(out).toContain('<h1>Ahoj</h1>');
    expect((out.match(/<style/g) || []).length).toBe(1);
    expect((out.match(/<script/g) || []).length).toBe(1);
  });

  it('bez placeholderov: index.html nezmenený', () => {
    const out = vfsJoinBlocks('<html><body>x</body></html>', 'a{}', 'z()');
    expect(out).toBe('<html><body>x</body></html>');
  });
});
