/** Agent 10 (wave 4): disposable loopback-only chaos E2E fixture.
 *  pg-mem + mock/fixture AI provider (no network) + actual Hono app, compiler and publish service.
 *  No application secrets: the cookie signing secret is random per process. */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { newDb } from 'pg-mem';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.CHAOS_UI_FIXTURE !== '1' || process.env.NODE_ENV !== 'test') throw new Error('Explicit chaos E2E fixture only');
if (process.env.LOV_SERVER === '1') throw new Error('LOV_SERVER must stay unset for the chaos fixture');

const port = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 3002 || value > 65535) throw new Error(name + ' must be a port >= 3002');
  return value;
};
const API_PORT = port('CHAOS_API_PORT', 3012), WEB_PORT = port('CHAOS_WEB_PORT', 3013);
const PUBLIC_PORT = port('CHAOS_PUBLIC_PORT', 3014), JOBS_WEB_PORT = port('CHAOS_JOBS_WEB_PORT', 3015);
const WEB = 'http://localhost:' + WEB_PORT, JOBS_WEB = 'http://localhost:' + JOBS_WEB_PORT;
// Must be set before server modules read the origin allowlist.
process.env.GITHUB_ALLOWED_ORIGINS = WEB + ',' + JOBS_WEB;
for (const key of ['MISTRAL_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'REDIS_URL', 'STRIPE_SECRET_KEY', 'AGENT_JOBS_WORKER']) delete process.env[key];

const { dbFromPool } = await import('../../server/db/pool');
const { applyMigrations } = await import('../../server/db/migrate');
const { createApp, makeMockProvider } = await import('../../server/index');
const { ProviderRegistry } = await import('../../server/providers/registry');
const { InMemoryQuotaStore } = await import('../../server/security/quotaStore');
const { InMemoryAiUsageStore } = await import('../../server/usage/store');
const { signToken } = await import('../../server/auth/tokens');
const { HostExecutor } = await import('../../server/sandbox/executor');
const { PublishService } = await import('../../server/publish/service');
const { publicPublishApp } = await import('../../server/publish/public');
const { WorkspaceSchema } = await import('../../shared/projectSchema');
const { registerProjectByteLength } = await import('../helpers/projectMemoryDb');
const { PATCH_PROJECT_FILES } = await import('./patchProject');
const { BUILD_REPAIR_MARKER } = await import('./buildRepairProject');
type AIProvider = import('../../server/providers/types').AIProvider;

const CHAOS_REPAIR_FAIL_MARKER = '// CHAOS_REPAIR_ALWAYS_FAILS\n';

/* ---- deterministic file sets (seeded per test user) ---- */
type Source = { path: string; content: string };
const base: Source[] = PATCH_PROJECT_FILES.map(file => ({ ...file }));
const withApp = (prefix: string, suffix = ''): Source[] =>
  base.map(file => file.path === 'src/App.tsx' ? { ...file, content: prefix + file.content + suffix } : file);
const SEEDS: Record<string, Source[]> = {
  clean: base,
  repair: withApp(BUILD_REPAIR_MARKER),
  'repair-fail': withApp(CHAOS_REPAIR_FAIL_MARKER + BUILD_REPAIR_MARKER),
  'ast-fs': withApp("import fs from 'fs';\n", '\nexport const leak = () => fs;\n'),
  'ast-eval': withApp('', "\nexport const run = () => eval('1');\n"),
  'ast-env': withApp('', '\nexport const key = process.env.X;\n'),
  'ast-evil': [...base.map(file => file.path === 'src/main.tsx' ? { ...file, content: "import './evil.txt';\n" + file.content } : file),
    { path: 'src/evil.txt', content: 'chaos fixture text, never executable\n' }],
  editor: [...base,
    { path: 'src/components/PrimaryButton.tsx', content: 'export function PrimaryButton(){return <button className="primary">OK</button>;}\n' },
    { path: 'src/utils/formatPrice.ts', content: 'export const formatPrice = (value: number) => value.toFixed(2) + " €";\n' },
    { path: 'src/hooks/useCounter.ts', content: 'import {useState} from "react";\nexport function useCounter(){const [n,setN]=useState(0);return {n,inc:()=>setN(n+1)};}\n' }],
};

/* ---- fixture provider: mock AI + deterministic build repair, with a call counter ---- */
const counters = { total: 0, repair: 0 };
function chaosProvider(): AIProvider {
  const mock = makeMockProvider();
  return {
    ...mock,
    name: 'mock-chaos',
    model: 'chaos-fixture',
    async complete(messages, opts) {
      counters.total++;
      if (messages[0]?.content.includes('Forge Build Repair')) {
        counters.repair++;
        const data = JSON.parse(messages[1].content) as { files: Array<{ path: string; content: string; sha256: string }> };
        const file = data.files.find(f => /const broken\d* = ;\n/.test(f.content));
        if (!file) return { text: JSON.stringify({ version: 1, summary: 'Nič na opravu.', changes: [] }), model: 'chaos-fixture', usage: { promptTokens: 10, completionTokens: 5 } };
        const search = file.content.match(/const broken\d* = ;\n/)![0];
        const n = Number(search.match(/broken(\d*)/)![1] || 0);
        const replace = file.content.includes(CHAOS_REPAIR_FAIL_MARKER.trim()) ? `const broken${n + 1} = ;\n` : '';
        return { text: JSON.stringify({ version: 1, summary: replace ? 'Syntetický neúspešný pokus.' : 'Odstránená iba chybná testovacia deklarácia.', changes: [{ path: file.path, action: 'modify', beforeSha256: file.sha256, edits: [{ search, replace }] }] }), model: 'chaos-fixture', usage: { promptTokens: 60, completionTokens: 25 } };
      }
      return mock.complete(messages, opts);
    },
    async *stream(messages, opts) {
      counters.total++;
      yield* mock.stream(messages, opts);
    },
  };
}

/* ---- database, auth, publish ---- */
const mem = newDb();
registerProjectByteLength(mem);
const pool = new (mem.adapters.createPg().Pool)(), db = dbFromPool(pool);
await applyMigrations(db);
const artifactDir = await mkdtemp(join(tmpdir(), 'lov-chaos-publish-'));
const publishConfig = { baseUrl: `http://127.0.0.1:${PUBLIC_PORT}/`, appUrl: WEB + '/', artifactDir, bind: '127.0.0.1', port: PUBLIC_PORT,
  maxArtifacts: 100, maxOwnerBytes: 200_000_000, maxArtifactBytes: 3_000_000, allowHostTest: true };
const publisher = new PublishService(db, publishConfig, new HostExecutor());
const secret = randomBytes(32).toString('hex');
const provider = chaosProvider();
const registry = new ProviderRegistry([{ id: 'default', label: 'AI test', provider }]);
const backend = createApp({ sandboxMode: 'host' }, provider, { providers: registry, rateLimit: () => true,
  auth: { db, jwtSecret: secret, quota: new InMemoryQuotaStore(), usage: new InMemoryAiUsageStore(), publish: publisher } });

const app = new Hono();
const USER = /^[a-z0-9-]{3,48}$/;
/** Creates (once) a disposable user, optionally seeds a server project, sets session cookies, redirects to the app. */
app.get('/__test/session/:user', async c => {
  const user = c.req.param('user'), seed = c.req.query('seed'), web = c.req.query('web') === 'jobs' ? JOBS_WEB : WEB;
  if (!USER.test(user) || (seed !== undefined && !SEEDS[seed])) return c.json({ error: 'invalid_fixture_request' }, 400);
  await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [user, user + '@example.test', 'not-a-login-password']);
  if (seed) {
    const files = SEEDS[seed].map(file => ({ name: file.path, content: file.content, modified: false }));
    const workspace = WorkspaceSchema.parse({ title: 'Chaos ' + seed, isPublic: false, liveId: 'seed-v1',
      snapshots: [{ id: 'seed-v1', v: 1, prompt: 'Chaos fixture ' + seed, kind: 'template', time: 'test', html: files.find(f => f.name === 'index.html')!.content, sourceFiles: JSON.stringify(files) }], files });
    await db.query('INSERT INTO builder_projects (owner_id,project_id,title,revision,workspace) VALUES ($1,$2,$3,1,$4::jsonb) ON CONFLICT DO NOTHING',
      [user, 'chaos-' + seed, workspace.title, JSON.stringify(workspace)]);
  }
  const token = await signToken({ sub: user, email: user + '@example.test', plan: 'free' }, secret);
  c.header('Set-Cookie', 'lov_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600');
  c.header('Set-Cookie', 'lov_csrf=chaos-csrf-' + user + '; Path=/; SameSite=Lax; Max-Age=3600', { append: true });
  return c.redirect(web + '/');
});
app.get('/__test/ai-calls', c => c.json({ ...counters }));
app.get('/__test/jobs/:user', async c => {
  const rows = (await db.query('SELECT id, idempotency_key, state FROM agent_jobs WHERE owner_id=$1 ORDER BY created_at', [c.req.param('user')])).rows;
  return c.json({ jobs: rows.map(row => ({ id: row.id, key: row.idempotency_key, state: row.state })) });
});
app.get('/__test/project/:user/:project', async c => {
  const row = (await db.query('SELECT revision, workspace FROM builder_projects WHERE owner_id=$1 AND project_id=$2', [c.req.param('user'), c.req.param('project')])).rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  const workspace = typeof row.workspace === 'string' ? JSON.parse(row.workspace) : row.workspace;
  return c.json({ revision: row.revision, liveId: workspace.liveId, snapshots: workspace.snapshots.length, files: workspace.files.map((f: { name: string; content: string }) => ({ name: f.name, content: f.content })) });
});
app.get('/__test/publish/:user', async c => {
  const user = c.req.param('user');
  const jobs = (await db.query("SELECT request_id, project_id, project_revision, state FROM publish_jobs WHERE owner_id=$1 ORDER BY created_at", [user])).rows;
  const live = (await db.query('SELECT project_id, alias_id, request_id FROM publish_live_addresses WHERE owner_id=$1', [user])).rows;
  return c.json({ jobs: jobs.map(j => ({ requestId: j.request_id, projectId: j.project_id, revision: j.project_revision, state: j.state })),
    live: live.map(l => ({ projectId: l.project_id, url: `http://127.0.0.1:${PUBLIC_PORT}/p/live/${l.alias_id}/`, requestId: l.request_id })) });
});
app.route('/', backend);

const api = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: API_PORT });
const published = serve({ fetch: publicPublishApp(publishConfig, db, publisher.artifacts).fetch, hostname: '127.0.0.1', port: PUBLIC_PORT });
async function stop() {
  api.close(); published.close();
  await publisher.settled().catch(() => {});
  await pool.end().catch(() => {});
  await rm(artifactDir, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
console.log(`Chaos fixture: API 127.0.0.1:${API_PORT}, public 127.0.0.1:${PUBLIC_PORT}; pg-mem, mock AI, disposable users only`);
