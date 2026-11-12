// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BLUEPRINT_REGISTRY, searchBlueprints } from '../../src/templates/registry';
import { brandBlueprint } from '../../src/templates/factory';
import { buildProject } from '../../server/sandbox/builder';
import { validateFiles } from '../../server/sandbox/policy';
import { containsPotentialSecret } from '../../server/security/secrets';

describe('real project blueprints', () => {
  it('contains distinct, complete and policy-compliant projects for the supported workflows', () => {
    expect(BLUEPRINT_REGISTRY.map(t => t.id)).toEqual(expect.arrayContaining([
      'booking', 'invoice', 'event-registration', 'job-board', 'recipes', 'members-area', 'blog-cms',
    ]));
    expect(new Set(BLUEPRINT_REGISTRY.map(t => t.id)).size).toBe(BLUEPRINT_REGISTRY.length);
    expect(new Set(BLUEPRINT_REGISTRY.map(t => t.files.find(f => f.path === 'src/App.tsx')?.content)).size).toBe(BLUEPRINT_REGISTRY.length);
    for (const template of BLUEPRINT_REGISTRY) {
      expect(template.followups.length).toBeGreaterThanOrEqual(3);
      expect(template.files.length).toBeGreaterThanOrEqual(8);
      expect(template.files.length).toBeLessThanOrEqual(14);
      expect(validateFiles(template.files)).toEqual([]);
      expect(containsPotentialSecret(JSON.stringify(template))).toBe(false);
      expect(template.files.map(f => f.path)).toEqual(expect.arrayContaining(['package.json', 'index.html', 'tsconfig.json', 'src/main.tsx', 'src/App.tsx', 'src/index.css']));
    }
  });

  it.each(BLUEPRINT_REGISTRY.map(t => [t.id, t] as const))('compiles %s using the real shared compiler', async (_id, template) => {
    const result = await buildProject(template.files);
    expect(result.errors).toEqual([]); expect(result.ok).toBe(true);
    expect(result.html).toContain("connect-src 'none'");
    expect(result.html).toContain("form-action 'none'");
  });

  it('searches accents, all words and category together', () => {
    expect(searchBlueprints('uloHY')).toHaveLength(2);
    expect(searchBlueprints('crm kontakty', 'Biznis').map(t => t.id)).toEqual(['admin-crud']);
    expect(searchBlueprints('crm', 'Obsah')).toEqual([]);
    expect(searchBlueprints('nenajdeny')).toEqual([]);
  });

  it('serializes hostile brand names as data and validates the color', async () => {
    const original = BLUEPRINT_REGISTRY[0];
    const name = '</title><script>alert("x")</script>';
    const branded = brandBlueprint(original, { name, color: '#16a34a' });
    expect(branded.files.find(f => f.path === 'src/brand.ts')?.content).toContain(JSON.stringify({ name }));
    const index = branded.files.find(f => f.path === 'index.html')!.content;
    expect(index).toContain('&lt;/title&gt;'); expect(index).not.toContain('<script>alert');
    expect(branded.files.find(f => f.path === 'src/index.css')?.content).toContain('--brand:#16a34a');
    expect(original.files.find(f => f.path === 'src/brand.ts')?.content).toContain('VORKEI Starter');
    expect((await buildProject(branded.files)).ok).toBe(true);
    expect(brandBlueprint(original, { name: '', color: 'red; background:url(https://example.com)' }).files.find(f => f.path === 'src/index.css')?.content).toContain('--brand:#2563eb');
  });

  it('allows parent-relative virtual imports but rejects escaping the virtual root', async () => {
    const files = [
      { path: 'src/main.tsx', content: 'import {Title} from "./components/Title"; console.log(Title);' },
      { path: 'src/components/Title.tsx', content: 'import {value} from "../data"; export const Title=()=> <h1>{value}</h1>;' },
      { path: 'src/data.ts', content: 'export const value="ok";' },
    ];
    expect((await buildProject(files)).ok).toBe(true);
    files[1].content = 'import {value} from "../../../src/data"; export const Title=()=> <h1>{value}</h1>;';
    const result = await buildProject(files);
    expect(result.ok).toBe(false); expect(JSON.stringify(result.errors)).toContain('koreň projektu');
  });

  it('keeps custom light and dark brand colors readable', () => {
    const css = (color: string) => brandBlueprint(BLUEPRINT_REGISTRY[0], { name: 'Brand', color }).files.find(file => file.path === 'src/index.css')!.content;
    expect(css('#ffffff')).toContain('--on-brand:#000000');
    expect(css('#000000')).toContain('--on-brand:#ffffff');
    expect(css('#2563eb')).toContain('--on-brand:#ffffff');
    expect(css('#ffff00')).toContain('--on-brand:#000000');
    expect(css('#ffffff')).not.toContain('--brand-text:#ffffff');
    expect(css('#ffffff')).toContain('color:var(--on-brand)');
  });
});
