// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactStore } from "../../../server/publish/artifacts";
import { FilesystemGate } from "../../../server/publish/storageGate";
import { publicPublishApp } from "../../../server/publish/public";
import type { PublishConfig } from "../../../server/publish/config";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "lov-public-isolation-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const writeGate = new FilesystemGate(2, 8, 5000), readGate = new FilesystemGate(2, 8, 5000);
  const store = new ArtifactStore(directory, 10000, 0, writeGate, readGate);
  const id = randomUUID(), html = "<main>public gate isolation</main>", receipt = await store.put(id, html);
  const config: PublishConfig = { baseUrl: "http://127.0.0.1:8791/", appUrl: "http://localhost:5176/", artifactDir: directory, bind: "127.0.0.1", port: 8791, maxArtifacts: 20, maxOwnerBytes: 100000, maxArtifactBytes: 10000, allowHostTest: true };
  const app = publicPublishApp(config, { query: async () => ({ rows: [{ artifact_id: id, artifact_sha256: receipt.sha256, artifact_bytes: receipt.bytes }], rowCount: 1 }) }, store);
  const request = () => app.request(config.baseUrl + "p/" + id + "/", { headers: { Host: "127.0.0.1:8791" } });
  function occupy(gate: FilesystemGate) {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const active = [0, 1].map(() => gate.submit(async lease => { expect(lease.beginIO()).toBe(true); await hold; }));
    cleanup.push(async () => { release(); await Promise.all(active.map(operation => operation.settled)); await gate.idle(); });
    return release;
  }
  return { store, request, occupy, writeGate, readGate, html };
}
it("keeps publication readiness and writes available when anonymous reads fill their bounded queue", async () => {
  const { store, request, occupy, readGate, writeGate, html } = await fixture();
  const release = occupy(readGate);
  // Real anonymous HTTP requests exhaust the remaining read queue; the ninth
  // request is refused without allocating an additional filesystem operation.
  const queued = Array.from({ length: 8 }, request);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(readGate.stats).toEqual({ active: 2, queued: 8 });
  expect((await request()).status).toBe(404);
  expect(await store.ready()).toBe(true);
  expect(await store.put(randomUUID(), "<main>new publication</main>")).toMatchObject({ bytes: 28 });
  expect(writeGate.stats).toEqual({ active: 0, queued: 0 });
  expect(readGate.stats).toEqual({ active: 2, queued: 8 });
  release();
  for (const response of await Promise.all(queued)) {
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe(html);
  }
});
it("serves an immutable public artifact while the publication filesystem gate is saturated", async () => {
  const { request, occupy, writeGate, readGate, html } = await fixture();
  occupy(writeGate);
  for (let index = 0; index < 8; index++) writeGate.submit(async lease => { expect(lease.beginIO()).toBe(true); });
  expect(writeGate.stats).toEqual({ active: 2, queued: 8 });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html);
  expect(readGate.stats).toEqual({ active: 0, queued: 0 });
  expect(writeGate.stats).toEqual({ active: 2, queued: 8 });
});
