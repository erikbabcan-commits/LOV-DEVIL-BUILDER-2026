/* Port 1:1 z demo/index.html (M1.1-D3d finálna verzia) + typy.
   FAITHFUL RECONSTRUCTION OVER CONSOLIDATION:
   - JS: extrahuje sa iba JEDEN klasický inline script bez atribútov (spájanie mení
     vykonávaciu sémantiku — duplicitné deklarácie, "use strict" presah, throw izolácia,
     document.currentScript). Viac klasických inline scriptov = všetky ostanú inline.
   - CSS: style bez atribútov je bezpečné spájať (kaskáda = poradie pravidiel), ale len
     adjacent skupina. Style s atribútmi (media=) ostáva na mieste.
   - Module/JSON/src/importmap bloky sa nikdy nedotýkajú. */

export interface VfsBlock { attrs: string; content: string }
export interface VfsSplitResult {
  indexHtml: string;
  cssParts: VfsBlock[];
  jsParts: VfsBlock[];
  skippedScript: boolean;
  skippedStyle: boolean;
}
export interface VfsFile { name: string; content: string; modified: boolean }

/** Static srcdoc preview must not resolve generated external scripts against the host app. */
export function withoutExternalScripts(html: string): string {
  return html.replace(/<script\b(?=[^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

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
  let skippedStyle = false;

  const markStyle = (attrs: string, content: string, orig: string): string => {
    if (/\S/.test(attrs || '')) return orig;
    cssParts.push({ attrs: '', content: content != null ? content : '' });
    return '<link rel="stylesheet" href="styles.css">';
  };
  const markScript = (attrs: string, content: string, orig: string): string => {
    const type = vfsBlockType(attrs);
    if (!vfsIsClassicJs(type, attrs)) { skippedScript = true; return orig; }
    jsParts.push({ attrs: '', content: content != null ? content : '' });
    return '<script src="app.js"></script>';
  };
  let indexHtml = html
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (m, a, c) => markStyle(a, c, m))
    .replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (m, a, c) => markScript(a, c, m));

  if (jsParts.length > 1) {
    let pi = 0;
    indexHtml = indexHtml.replace(/<script src="app\.js"><\/script>/g, () => {
      const part = jsParts[pi++];
      return '<script>' + ((part && part.content) || '') + '</script>';
    });
    skippedScript = true;
    jsParts.length = 0;
  }

  const PHC = '<link rel="stylesheet" href="styles.css">';
  if (cssParts.length > 1 && indexHtml.includes(PHC)) {
    const posc: number[] = [];
    const reC = /<link rel="stylesheet" href="styles\.css">/g;
    let cm: RegExpExecArray | null;
    while ((cm = reC.exec(indexHtml)) !== null) posc.push(cm.index);
    for (let i = 1; i < posc.length; i++) {
      const between = indexHtml.slice(posc[i - 1] + PHC.length, posc[i]);
      if (!/^\s*$/.test(between)) {
        let ci = 0;
        indexHtml = indexHtml.replace(/<link rel="stylesheet" href="styles\.css">/g, () => {
          const part = cssParts[ci++];
          return '<style>' + ((part && part.content) || '') + '</style>';
        });
        skippedStyle = true;
        cssParts.length = 0;
        break;
      }
    }
  }
  return { indexHtml, cssParts, jsParts, skippedScript, skippedStyle };
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
    const block = '<script>\n' + jsContent + '\n</script>';
    html = html.replace(reJS, () => block);
    html = html.split('<script src="app.js"></script>').join('');
  }
  return html;
}
