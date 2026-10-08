import { vfsSplitBlocks, vfsJoinBlocks } from './index';
import type { VfsFile } from './index';
export type { VfsFile } from './index';

export interface SnapshotForVfs { id: string; prompt: string; v: number; time: string; html: string }

export function filesFor(snap: SnapshotForVfs): VfsFile[] {
  const html = snap.html;
  const { indexHtml, cssParts, jsParts } = vfsSplitBlocks(html);
  const cssHeader = cssParts.length > 1 ? '/* VFS: ' + cssParts.length + ' style bloky spojené v pôvodnom poradí */\n' : '';
  const jsHeader = jsParts.length > 1 ? '// VFS: ' + jsParts.length + ' script bloky spojené v pôvodnom poradí\n' : '';
  const css = cssParts.map(p => p.content.trim()).join('\n');
  const js = jsParts.map(p => p.content.trim()).join('\n');
  return [
    { name: 'index.html', content: indexHtml.trim(), modified: false },
    { name: 'styles.css', content: css ? cssHeader + css : '/* žiadne štýly */', modified: false },
    { name: 'app.js', content: js ? jsHeader + js : '// žiadna logika', modified: false },
    { name: 'README.md', content: '# ' + snap.prompt.slice(0, 60) + '\n\nVygenerované vo Forge AI Builder · v' + snap.v + ' · ' + snap.time + '\nSúbory: index.html, styles.css, app.js — edituj v záložke Súbory.', modified: false },
  ];
}

export function filesToHtml(files: VfsFile[]): string {
  const f: Record<string, string> = {};
  files.forEach(x => { f[x.name] = x.content; });
  return vfsJoinBlocks(f['index.html'] || '', f['styles.css'] || '', f['app.js'] || '');
}
