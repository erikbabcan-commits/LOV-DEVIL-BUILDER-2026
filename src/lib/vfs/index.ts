/* Port 1:1 z demo/index.html (M1-D3c finálna verzia) + typy */

export interface VfsBlock { attrs: string; content: string }
export interface VfsSplitResult { indexHtml: string; cssParts: VfsBlock[]; jsParts: VfsBlock[]; skippedScript: boolean }
export interface VfsFile { name: string; content: string; modified: boolean }

export function vfsBlockType(attrs: string | undefined): string {
  const m = (attrs || '').match(/type\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/i);
  return m ? (m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4] || '')) : '';
}

export function vfsIsClassicJs(type: string, attrs: string | undefined): boolean {
  return (!type || /^(text|application)\/(javascript|ecmascript)$/i.test(type)) && !/\ssrc\s*=/.test(attrs || '');
}

export function vfsSplitBlocks(html: string): VfsSplitResult {
  const cssParts: VfsBlock[] = [];
  const jsParts: VfsBlock[] = [];
  let skippedScript = false;

  const markStyle = (attrs: string, content: string, orig: string): string => {
    if (/\S/.test(attrs || '')) return orig;
    cssParts.push({ attrs: '', content: content != null ? content : '' });
    return '<link rel="stylesheet" href="styles.css">';
  };
  const markScript = (attrs: string, content: string, orig: string): string => {
    const type = vfsBlockType(attrs);
    if (!vfsIsClassicJs(type, attrs)) { skippedScript = true; return orig; }
    jsParts.push({ attrs: '', content: content != null ? content : '' });
    return '<script src="app.js"><\/script>';
  };
  let indexHtml = html
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (m, a, c) => markStyle(a, c, m))
    .replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (m, a, c) => markScript(a, c, m));

  const PH = '<script src="app.js"><\/script>';
  if (indexHtml.includes(PH)) {
    const positions: number[] = [];
    const rePH = /<script src="app\.js"><\/script>/g;
    let pm: RegExpExecArray | null;
    while ((pm = rePH.exec(indexHtml)) !== null) positions.push(pm.index);
    let groups = 1;
    for (let i = 1; i < positions.length; i++) {
      const between = indexHtml.slice(positions[i - 1] + PH.length, positions[i]);
      if (!/^\s*$/.test(between)) groups++;
    }
    if (groups > 1) {
      let pi = 0;
      indexHtml = indexHtml.replace(/<script src="app\.js"><\/script>/g, () => {
        const part = jsParts[pi++];
        return '<script>' + ((part && part.content) || '') + '<\/script>';
      });
      skippedScript = true;
      jsParts.length = 0;
    }
  }
  return { indexHtml, cssParts, jsParts, skippedScript };
}

export function vfsJoinBlocks(indexHtml: string, cssContent: string, jsContent: string): string {
  const reCSS = /<link rel="stylesheet" href="styles\.css">/;
  const reJS = /<script src="app\.js"><\/script>/;
  let html = indexHtml;
  if (reCSS.test(html)) {
    const block = '<style>\n' + cssContent + '\n</style>';
    html = html.replace(reCSS, () => block);
    html = html.split('<link rel="stylesheet" href="styles.css">').join('');
  }
  if (reJS.test(html)) {
    const block = '<script>\n' + jsContent + '\n<\/script>';
    html = html.replace(reJS, () => block);
    html = html.split('<script src="app.js"><\/script>').join('');
  }
  return html;
}
