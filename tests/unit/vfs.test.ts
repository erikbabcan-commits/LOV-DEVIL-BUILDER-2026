import { describe, it, expect } from 'vitest';
import { vfsSplitBlocks, vfsJoinBlocks } from '../../src/lib/vfs';

describe('VFS D3c (M1)', () => {
  it('interleaved scripty (oddelené DOM) sa NEextrahujú — exact preservation', () => {
    const src = '<body><script>first()<\/script><div id="x">X</div><script>second()<\/script></body>';
    const r = vfsSplitBlocks(src);
    expect(r.jsParts.length).toBe(0);
    expect(r.indexHtml).toContain('first()');
    expect(r.indexHtml).toContain('second()');
    expect(r.indexHtml.indexOf('first()')).toBeLessThan(r.indexHtml.indexOf('<div'));
    expect(r.indexHtml.indexOf('<div')).toBeLessThan(r.indexHtml.indexOf('second()'));
    expect(r.skippedScript).toBe(true);
  });

  it('adjacent scripty sa extrahujú a spájajú (bezpečné)', () => {
    const src = '<head><script>a()<\/script>\n<script>b()<\/script></head><body>ok</body>';
    const r = vfsSplitBlocks(src);
    expect(r.jsParts.length).toBe(2);
    expect(r.jsParts[0].content).toContain('a()');
    expect(r.jsParts[1].content).toContain('b()');
    expect(r.indexHtml).not.toContain('a()');
  });

  it('module/JSON/src/atribútové bloky sa NESPÁJAJÚ', () => {
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

  it('multi-block CSS roundtrip zachová poradie (kaskáda)', () => {
    const src = '<style>a{color:red}</style><p>x</p><style>a{color:blue}</style>';
    const r = vfsSplitBlocks(src);
    const css = r.cssParts.map(p => p.content.trim()).join('\n');
    expect(css.indexOf('color:red')).toBeLessThan(css.indexOf('color:blue'));
    const out = vfsJoinBlocks(r.indexHtml, css, '');
    expect(out).toContain('color:red');
    expect(out).toContain('color:blue');
  });

  it('roundtrip: jednoduchá appka sa zachová', () => {
    const src = '<html><head><style>a{b:c}</style></head><body><h1>Ahoj</h1><script>let x = 1<\/script></body></html>';
    const r = vfsSplitBlocks(src);
    const out = vfsJoinBlocks(r.indexHtml, r.cssParts[0].content, r.jsParts[0].content);
    expect(out).toContain('a{b:c}');
    expect(out).toContain('let x = 1');
    expect(out).toContain('<h1>Ahoj</h1>');
  });
});
