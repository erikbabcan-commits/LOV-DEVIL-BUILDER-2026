// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDashboard, buildKanban, buildSaas, buildSettings } from '../../src/lib/templates';

const css = readFileSync(new URL('../../src/styles/forge.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = new Map<string, string>();

for (const root of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const declaration of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    tokens.set(declaration[1], declaration[2].trim());
  }
}

function resolveColor(token: string, visited = new Set<string>()): string {
  if (visited.has(token)) throw new Error(`Circular theme token: ${token}`);
  visited.add(token);
  const value = tokens.get(token);
  if (!value) throw new Error(`Missing theme token: ${token}`);
  const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (alias) return resolveColor(alias[1], visited);
  if (!/^#[\da-f]{6}$/i.test(value)) {
    throw new Error(`Theme contrast test needs an opaque six-digit color: ${token}=${value}`);
  }
  return value.toUpperCase();
}

// sRGB relative luminance; use unrounded ratios when checking the thresholds.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function blockContents(openBrace: number): string {
  let depth = 1;
  for (let cursor = openBrace + 1; cursor < css.length; cursor += 1) {
    if (css[cursor] === '{') depth += 1;
    if (css[cursor] === '}') depth -= 1;
    if (depth === 0) return css.slice(openBrace + 1, cursor);
  }
  throw new Error('Unclosed theme CSS block');
}

const surfaces = ['--bg-app', '--bg-panel', '--bg-elevated', '--bg-hover'];
const textColors = [
  '--text-primary', '--text-secondary', '--text-muted', '--accent-text',
  '--danger-text', '--success', '--warning',
];
const textPairs = textColors.flatMap(foreground => surfaces.map(background => [foreground, background]));
const diffPairs = ['--text-primary', '--text-secondary', '--text-muted']
  .flatMap(foreground => ['--diff-add', '--diff-delete'].map(background => [foreground, background]));

describe('dark shell theme tokens', () => {
  it('keeps the requested application background exactly #171717', () => {
    expect(resolveColor('--bg-app')).toBe('#171717');
  });

  it.each([
    ['--bg', '--bg-app'],
    ['--panel', '--bg-panel'],
    ['--panel-2', '--bg-elevated'],
    ['--panel-3', '--bg-hover'],
    ['--text', '--text-primary'],
    ['--text-dim', '--text-secondary'],
    ['--muted', '--text-muted'],
    ['--ok', '--success'],
    ['--warn', '--warning'],
    ['--err', '--danger-text'],
  ])('routes the legacy %s alias to %s', (alias, canonical) => {
    expect(tokens.get(alias)?.replace(/\s+/g, '')).toBe(`var(${canonical})`);
    expect(resolveColor(alias)).toBe(resolveColor(canonical));
  });

  it('validates the contrast calculation against reference endpoints', () => {
    expect(contrast('#000000', '#FFFFFF')).toBe(21);
    expect(contrast('#171717', '#171717')).toBe(1);
  });

  it.each(textPairs)('%s has normal-text contrast on %s', (foreground, background) => {
    const ratio = contrast(resolveColor(foreground), resolveColor(background));
    expect(ratio, `${foreground} / ${background}: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(diffPairs)('%s remains readable on %s diff rows', (foreground, background) => {
    const ratio = contrast(resolveColor(foreground), resolveColor(background));
    expect(ratio, `${foreground} / ${background}: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(textColors)('%s remains readable on accent-soft surfaces', foreground => {
    const ratio = contrast(resolveColor(foreground), resolveColor('--accent-soft'));
    expect(ratio, `${foreground} / accent-soft: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['--accent-primary', '--accent-hover', '--accent-active'])('keeps button labels readable on %s', background => {
    const ratio = contrast(resolveColor('--text-on-accent'), resolveColor(background));
    expect(ratio, `accent label / ${background}: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each([...surfaces, '--accent-primary', '--accent-hover', '--accent-active'])('keeps the keyboard focus ring visible against %s', background => {
    const ratio = contrast(resolveColor('--focus-ring'), resolveColor(background));
    expect(ratio, `focus ring / ${background}: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(3);
  });

  it.each(surfaces)('keeps control boundaries visible against %s', background => {
    const ratio = contrast(resolveColor('--border-control'), resolveColor(background));
    expect(ratio, `control border / ${background}: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(3);
  });

  it('declares a dark native-control scheme', () => {
    expect(/color-scheme\s*:\s*dark\s*[;}]/.test(css)).toBe(true);
  });

  it.each([
    'html', 'body', '#root', '.home', '#workspaceView', '#editorView',
    '.chat-panel', '.canvas-panel', '.viewport-wrap', '.topbar', '.mtabs',
    '.ed-main', '.ed-side', '.ed-tabs', '.canvas-tabs',
  ])('binds every %s background declaration to the exact app base', selector => {
    // Check explicit shell rules, including grouped selectors and media overrides.
    // This is a declaration contract, not an emulation of browser CSS cascade.
    const values = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      .filter(rule => rule[1].split(',').some(part => part.trim() === selector))
      .flatMap(rule => Array.from(rule[2].matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;}]+)/g)))
      .map(declaration => declaration[1].trim());
    expect(values.length, `Missing ${selector} background binding`).toBeGreaterThan(0);
    for (const value of values) {
      const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
      expect(alias, `Non-token ${selector} background: ${value}`).not.toBeNull();
      const token = alias?.[1] ?? '';
      expect(['--bg-app', '--bg']).toContain(token);
      expect(resolveColor(token)).toBe('#171717');
    }
  });

  it('places snapshot version text on an opaque, readable badge above thumbnail gradients', () => {
    const badgeRule = /\.snap-thumb-label\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(badgeRule).toMatch(/(?:^|;)\s*background(?:-color)?\s*:\s*var\(\s*--bg-app\s*\)\s*(?:;|$)/);
    expect(badgeRule).toMatch(/(?:^|;)\s*color\s*:\s*var\(\s*--text-primary\s*\)\s*(?:;|$)/);
    // This exact foreground/background pair is measured in the matrix above.
    const workspace = readFileSync(new URL('../../src/features/workspace/Workspace.tsx', import.meta.url), 'utf8');
    expect(workspace).toMatch(/<span\s+className=["']snap-thumb-label["']\s*>\s*v\{s\.v\}\s*<\/span>/);
  });

  it('uses the focus-ring token in a focus-visible rule', () => {
    const focusRules = Array.from(css.matchAll(/[^{}]*:focus-visible[^{}]*\{([^}]*)\}/g));
    expect(focusRules.some(rule => /var\(\s*--focus-ring\s*\)/.test(rule[1]))).toBe(true);
  });

  it('provides a reduced-motion override for transitions and animation', () => {
    const reducedMotion = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/.exec(css);
    expect(reducedMotion, 'Missing reduced-motion media query').not.toBeNull();
    const rules = reducedMotion ? blockContents(reducedMotion.index + reducedMotion[0].length - 1) : '';
    expect(rules).toMatch(/transition(?:-duration)?\s*:/);
    expect(rules).toMatch(/animation(?:-duration)?\s*:/);
  });

  it('does not keep conditionally mounted editor previews hidden by legacy CSS', () => {
    const frameRule = /#editorFrame\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const emptyRule = /\.ed-empty\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(frameRule).toMatch(/display\s*:\s*block/);
    expect(emptyRule).toMatch(/display\s*:\s*flex/);
    expect(frameRule).not.toMatch(/display\s*:\s*none/);
    expect(emptyRule).not.toMatch(/display\s*:\s*none/);
  });

  it('keeps the editor body a bounded flex container for scrollable code panes', () => {
    const rules = Array.from(css.matchAll(/\.ed-body\s*\{([^}]*)\}/g));
    expect(rules.some(rule => /display\s*:\s*flex/.test(rule[1]))).toBe(true);
    expect(rules.some(rule => /min-height\s*:\s*0/.test(rule[1]))).toBe(true);
  });

  it('provides the same dark base before the app stylesheet is loaded', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/<meta\s+name="theme-color"\s+content="#171717"/);
    expect(html).toMatch(/<style>\s*html\s*\{\s*background\s*:\s*#171717/);
  });
});

// Shell colors must not overwrite the independently designed generated apps.
// These static checks complement, rather than replace, rendered/browser checks.
describe('generated preview theme isolation', () => {
  const previews: [string, () => string, string][] = [
    ['SaaS', buildSaas, '#fafafc'],
    ['Kanban', buildKanban, '#101014'],
    ['Settings', buildSettings, '#f6f7f9'],
    ['Dashboard', () => buildDashboard('Theme isolation fixture'), '#f6f5f1'],
  ];

  it.each(previews)('preserves the %s preview background and avoids shell tokens', (_name, build, background) => {
    const html = build();
    const bodyRule = /body\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
    expect(bodyRule).toMatch(new RegExp(`background\\s*:\\s*${background}(?:\\s*;|\\s*$)`, 'i'));
    expect(html).not.toMatch(/--(?:bg-app|bg-panel|bg-elevated|bg-hover|text-primary|text-secondary|text-muted|focus-ring)\b/);
    expect(html).not.toContain('forge.css');
  });
});
