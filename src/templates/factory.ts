import type { Blueprint, BlueprintBrand } from './types';
import { templateTheme } from './theme';

type Definition = Omit<Blueprint, 'files'> & { app: string; data?: string; types?: string };
const file = (path: string, content: string) => ({ path, content, action: 'create' as const });
export function defineBlueprint({ app, data = 'export {};', types = 'export {};', ...meta }: Definition): Blueprint {
  return { ...meta, files: [
    file('package.json', JSON.stringify({ name: meta.id, version: '1.0.0', private: true, type: 'module',
      scripts: { dev: 'vite', build: 'tsc --noEmit && vite build', preview: 'vite preview' },
      dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: { '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1', typescript: '~5.6.2', vite: '^6.0.5' } }, null, 2)),
    file('index.html', '<!doctype html><html lang="sk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge Starter</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'),
    file('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true }, include: ['src'] }, null, 2)),
    file('vite.config.ts', 'import { defineConfig } from "vite";\nexport default defineConfig({});\n'),
    file('README.md', '# ' + meta.title + '\n\n' + meta.description + '\n\n## Spustenie\n\n```sh\nnpm install\nnpm run dev\nnpm run build\n```\n\nÚdaje sú ukážkové a stav je lokálny v prehliadači. Backend, platby, odosielanie správ a skutočné prihlasovanie treba pripojiť pred publikovaním. Šablóna neposiela dáta do externých služieb.\n'),
    file('src/main.tsx', 'import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\ncreateRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);\n'),
    file('src/index.css', templateTheme),
    file('src/App.tsx', app), file('src/data.ts', data), file('src/types.ts', types),
    file('src/brand.ts', 'export const brand = { name: "Forge Starter" };\n'),
    file('src/components/Header.tsx', 'import { brand } from "../brand";\nexport function Header({section}:{section:string}) {return <header className="app-header"><b>{brand.name}</b><span className="badge">{section}</span></header>;}\n'),
    file('src/components/EmptyState.tsx', 'export function EmptyState({title,detail}:{title:string;detail:string}) {return <div className="empty" role="status"><h3>{title}</h3><p>{detail}</p></div>;}\n'),
  ] };
}

/** Brand text is serialized into TS/HTML rather than interpolated as executable code. */
export function brandBlueprint(blueprint: Blueprint, brand: BlueprintBrand): Blueprint {
  const name = brand.name.trim().slice(0, 60) || blueprint.title;
  const color = /^#[0-9a-f]{6}$/i.test(brand.color) ? brand.color : '#2563eb';
  const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
  const luminance = (values: number[]) => values.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const light = luminance(rgb);
  const onBrand = (light + 0.05) / 0.05 > 1.05 / (light + 0.05) ? '#000000' : '#ffffff';
  let textRgb = [...rgb];
  while ((luminance([247, 249, 252]) + 0.05) / (luminance(textRgb) + 0.05) < 4.5)
    textRgb = textRgb.map(value => Math.floor(value * 0.85));
  const brandText = '#' + textRgb.map(value => value.toString(16).padStart(2, '0')).join('');
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return { ...blueprint, files: blueprint.files.map(item => {
    if (item.path === 'src/brand.ts') return { ...item, content: 'export const brand = ' + JSON.stringify({ name }) + ';\n' };
    if (item.path === 'src/index.css') return { ...item, content: item.content + '\n:root{--brand:' + color + ';--brand-text:' + brandText + ';--on-brand:' + onBrand + '}\n' };
    if (item.path === 'index.html') return { ...item, content: item.content.replace('<title>Forge Starter</title>', '<title>' + escape(name) + '</title>') };
    return { ...item };
  }) };
}
