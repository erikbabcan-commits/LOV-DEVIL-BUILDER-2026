import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/index';
import { applyMigrations } from '../../server/db/migrate';
import type { DbLike } from '../../server/db/pool';
import { signToken } from '../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../server/security/quotaStore';
import type { ProjectStoragePolicy } from '../../server/projects/storage';

export function projectStorageContract(name: string, connect: () => Promise<{ db: DbLike; close: () => Promise<void> }>, native = false) {
  describe(name, () => {
    let db: DbLike, close: () => Promise<void>, app: ReturnType<typeof createApp>, alice: string, bob: string;
    const secret = 'project-storage-test-secret-01234567890123456789';
    const workspace = (title = 'Žltý 🌍 projekt') => ({ title, isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Žltý 🌍</main>' }], files: [] });
    function configure(policy: ProjectStoragePolicy, database = db) {
      app = createApp({ projectStorage: policy }, null, { rateLimit: () => true, auth: { db: database, jwtSecret: secret, quota: new InMemoryQuotaStore() } });
    }
    beforeEach(async () => {
      ({ db, close } = await connect()); await applyMigrations(db);
      for (const id of ['alice','bob']) await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id,id+'@example.com','unused']);
      alice = await signToken({ sub: 'alice', email: 'alice@example.com', plan: 'free' }, secret);
      bob = await signToken({ sub: 'bob', email: 'bob@example.com', plan: 'pro' }, secret);
      configure({ maxBytes: 1_000_000, maxProjects: 2 });
    });
    afterEach(async () => { await close?.(); });
    const request = (path: string, body?: unknown, token = alice) => app.request('/api/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'lov_token=' + token + '; lov_csrf=storage-test', 'X-CSRF-Token': 'storage-test', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const save = (id: string, title?: string, revision = 0, token = alice) => request('projects/' + id, { expectedRevision: revision, workspace: workspace(title) }, token);
    const usage = async (token = alice) => (await request('project-storage', undefined, token)).json();
    it('counts UTF-8 JSONB bytes and retained projects only for the authenticated account', async () => {
      expect((await save('p1')).status).toBe(201);
      const response = await request('project-storage'); expect(response.headers.get('Cache-Control')).toBe('no-store');
      const current = await response.json();
      const text = (await db.query('SELECT workspace::text AS value FROM builder_projects WHERE owner_id=$1', ['alice'])).rows[0].value;
      expect(current).toMatchObject({ usedBytes: Buffer.byteLength(text,'utf8'), usedProjects: 1, trashedProjects: 0, warning: false });
      expect(current.usedBytes).toBeGreaterThan(text.length);
      expect(await usage(bob)).toMatchObject({ usedBytes: 0, usedProjects: 0 });
      expect((await request('project-storage?owner=bob')).status).toBe(400);
      expect((await request('project-storage', undefined, 'invalid')).status).toBe(401);
      expect((await createApp({},null).request('/api/project-storage')).status).toBe(404);
    });
    it('enforces the retained project cap without blocking another account or existing reads', async () => {
      expect((await save('p1')).status).toBe(201); expect((await save('p2')).status).toBe(201);
      const denied = await save('p3'); expect(denied.status).toBe(413); expect(await denied.json()).toMatchObject({ error: 'project_storage_quota', usage: { usedProjects: 2, warning: true } });
      expect((await request('projects/p1')).status).toBe(200); expect((await save('p3',undefined,0,bob)).status).toBe(201);
      expect(await usage()).toMatchObject({ usedProjects: 2 }); expect(await usage(bob)).toMatchObject({ usedProjects: 1 });
    });
    it('preserves revision and workspace after a byte-limit denial; trash and restore keep the same capacity charge', async () => {
      await save('p1'); const before = await usage(); configure({ maxBytes: before.usedBytes, maxProjects: 10 });
      expect((await save('p1','A much longer project title that requires extra storage',1)).status).toBe(413);
      expect(await (await request('projects/p1')).json()).toMatchObject({ revision: 1, workspace: { title: 'Žltý 🌍 projekt' } });
      expect((await request('projects/p1/delete',{expectedRevision:1})).status).toBe(200);
      expect(await usage()).toMatchObject({ usedBytes: before.usedBytes, usedProjects: 1, trashedProjects: 1 });
      expect((await save('new')).status).toBe(413);
      expect((await request('projects/p1/restore',{expectedRevision:2})).status).toBe(200);
      expect(await usage()).toMatchObject({ usedBytes: before.usedBytes, usedProjects: 1, trashedProjects: 0 });
    });
    it('allows unchanged or smaller saves after an operator reduces capacity, without deleting data', async () => {
      await save('p1'); await save('p2'); const before = await usage(); configure({ maxBytes: before.usedBytes-1, maxProjects: 1 });
      expect((await save('p1',undefined,1)).status).toBe(200);
      expect((await save('p1','A',2)).status).toBe(200);
      expect((await save('p3','A')).status).toBe(413);
      expect(await usage()).toMatchObject({ usedProjects: 2 });
    });
    it('fails closed for writes when the DB adapter cannot pin a transaction connection', async () => {
      configure({ maxBytes: 1_000_000, maxProjects: 2 }, { query: db.query });
      expect((await save('p1')).status).toBe(503);
      expect(await usage()).toMatchObject({ usedProjects: 0, usedBytes: 0 });
    });
    if (native) {
      it('permits only one of eight concurrent creations at the project-count cap', async () => {
        configure({ maxBytes: 1_000_000, maxProjects: 1 });
        const results = await Promise.all(Array.from({length:8},(_,i)=>save('p'+i)));
        expect(results.filter(r=>r.status===201)).toHaveLength(1); expect(results.filter(r=>r.status===413)).toHaveLength(7);
        expect(await usage()).toMatchObject({ usedProjects: 1 });
      });
      it('permits only one concurrent creation by bytes, using fresh snapshots despite a repeatable-read connection default', async () => {
        const text = (await db.query('SELECT $1::jsonb::text AS value',[JSON.stringify(workspace())])).rows[0].value;
        configure({ maxBytes: Math.floor(Buffer.byteLength(text,'utf8')*1.5), maxProjects: 100 });
        const results = await Promise.all(Array.from({length:8},(_,i)=>save('p'+i)));
        expect(results.filter(r=>r.status===201)).toHaveLength(1); expect(results.filter(r=>r.status===413)).toHaveLength(7);
        expect((await usage()).usedBytes).toBe(Buffer.byteLength(text,'utf8'));
      });
      it('serializes growth of different projects under the same byte budget', async () => {
        await save('p1','A'); await save('p2','A'); const before=await usage();
        const title='A'.repeat(100); configure({maxBytes:before.usedBytes+99,maxProjects:100});
        const results=await Promise.all([save('p1',title,1),save('p2',title,1)]);
        expect(results.map(r=>r.status).sort()).toEqual([200,413]);
        expect((await usage()).usedBytes).toBe(before.usedBytes+99);
      });
      it('rolls back a mutation on a thrown DB failure and allows a later clean save', async () => {
        const broken:DbLike={query:db.query,transaction:work=>db.transaction!(tx=>work({query:async(sql,params)=>{
          const result=await tx.query(sql,params); if(sql.startsWith('INSERT INTO builder_projects'))throw new Error('private-db-detail'); return result;
        }}))};
        configure({maxBytes:1_000_000,maxProjects:2},broken);
        const failed=await save('p1');expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('private-db-detail');
        expect(await usage()).toMatchObject({usedProjects:0,usedBytes:0});
        configure({maxBytes:1_000_000,maxProjects:2});expect((await save('p1')).status).toBe(201);
      });
    }
  });
}
