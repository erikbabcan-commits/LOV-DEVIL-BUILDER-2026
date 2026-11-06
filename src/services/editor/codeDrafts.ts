import { z } from "zod";
import type { AppState } from "../../stores/useAppStore";
import { filesFor } from "../../lib/vfs/filesFor";
import { loadMeta, saveMeta, persistenceScope } from "../persistence/db";
import { inspectProjectSources } from "../export/projectZip";

export interface CodeEditBase {
  projectId: string;
  snapshotId: string;
  liveId: string | null;
  viewingId: string | null;
  branch: string;
  source: string;
  epoch: number;
  draftId: string;
}
export interface CodeTab {
  name: string;
  draft: string;
  saved: string;
}
export function captureCodeEditBase(state: AppState): CodeEditBase | null {
  const snapshot = state.edSnap();
  if (!snapshot || state.workspaceEpoch !== persistenceScope().epoch)
    return null;
  const files = state.vfs[snapshot.id] ?? filesFor(snapshot);
  return {
    projectId: state.projectId,
    snapshotId: snapshot.id,
    liveId: state.liveId,
    viewingId: state.viewing?.id ?? null,
    branch: state.branch,
    epoch: persistenceScope().epoch,
    draftId: state.remoteSnapshotIds[snapshot.id] ?? snapshot.id,
    source: JSON.stringify({
      html: snapshot.html,
      files: files
        .map(({ name, content }) => ({ name, content }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }),
  };
}
export function matchesCodeEditBase(
  state: AppState,
  base: CodeEditBase,
): boolean {
  const current = captureCodeEditBase(state);
  return (
    current !== null &&
    Object.entries(base).every(
      ([key, value]) => Reflect.get(current, key) === value,
    )
  );
}
const Tabs = z
  .array(
    z
      .object({
        name: z.string().min(1).max(200),
        saved: z.string().max(200_000),
        draft: z.string().max(200_000),
      })
      .strict(),
  )
  .max(40);
const RecordSchema = z
  .object({
    version: z.literal(1),
    source: z.string().max(12_000_000),
    tabs: Tabs,
    active: z.string().nullable(),
  })
  .strict();
type Scope = ReturnType<typeof persistenceScope>;
const key = (base: CodeEditBase) =>
  "code-draft:v1:" +
  encodeURIComponent(base.projectId) +
  ":" +
  encodeURIComponent(base.draftId);
export async function readCodeDraft(scope: Scope, base: CodeEditBase) {
  const value = await loadMeta<unknown>(key(base), scope.databaseName);
  if (persistenceScope().epoch !== scope.epoch) return null;
  if (value === null) return null;
  const parsed = RecordSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Neplatný lokálny koncept. Pôvodné zdroje zostali zachované.",
    );
  const files = parsed.data.tabs.map((tab) => ({
    name: tab.name,
    content: tab.draft,
  }));
  if (files.length && inspectProjectSources(files).errors.length)
    throw new Error("Lokálny koncept neprešiel kontrolou súborov.");
  return { ...parsed.data, stale: parsed.data.source !== base.source };
}
export async function writeCodeDraft(
  scope: Scope,
  base: CodeEditBase,
  tabs: CodeTab[],
  active: string | null,
) {
  const record = RecordSchema.parse({
    version: 1,
    source: base.source,
    tabs,
    active,
  });
  const files = record.tabs.map((tab) => ({
    name: tab.name,
    content: tab.draft,
  }));
  if (files.length && inspectProjectSources(files).errors.length)
    throw new Error(
      "Koncept obsahuje nepovolené zdroje alebo možný kľúč. Nezálohoval sa.",
    );
  if (scope.databaseName === null) throw new Error("Úložisko je zamknuté.");
  await saveMeta(key(base), record, scope.databaseName);
}
export async function clearCodeDraft(scope: Scope, base: CodeEditBase) {
  await saveMeta(key(base), null, scope.databaseName);
}
