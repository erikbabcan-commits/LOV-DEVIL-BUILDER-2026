import { z } from "zod";
import { Files, WorkspaceSchema } from "./forge-workspace";
export const EditorDraftSchema = z.object({ base: z.string().max(3_000_000), files: Files });
export type EditorDraft = z.infer<typeof EditorDraftSchema>;
export const DraftSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  revision: z.number().int().nonnegative(),
  workspace: WorkspaceSchema,
  dirty: z.boolean(),
  editor: EditorDraftSchema.nullable().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;
export interface DraftInfo {
  id: string;
  title: string;
  dirty: boolean;
}
export interface DraftStorage {
  read(owner: string, id?: string): Promise<Draft | null>;
  write(owner: string, draft: Draft): Promise<void>;
  list?(owner: string): Promise<DraftInfo[]>;
}
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("forge-hybrid-workspaces", 1);
    request.onupgradeneeded = () => {
      const drafts = request.result.createObjectStore("drafts", { keyPath: ["owner", "id"] });
      drafts.createIndex("owner", "owner");
      request.result.createObjectStore("current");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(new Error("draft_unavailable"));
    };
  }));
}
export const browserDrafts: DraftStorage = {
  async read(owner, id) {
    const connection = await db();
    return new Promise((resolve, reject) => {
      const tx = connection.transaction(["drafts", "current"], "readonly");
      let value: unknown = null;
      const get = (projectId: string) => {
        const request = tx.objectStore("drafts").get([owner, projectId]);
        request.onsuccess = () => {
          value = request.result;
        };
      };
      if (id) get(id);
      else {
        const pointer = tx.objectStore("current").get(owner);
        pointer.onsuccess = () => {
          if (typeof pointer.result === "string") get(pointer.result);
        };
      }
      tx.oncomplete = () => {
        const parsed = DraftSchema.safeParse(value);
        resolve(parsed.success ? parsed.data : null);
      };
      tx.onerror = () => reject(new Error("draft_unavailable"));
    });
  },
  async list(owner) {
    const connection = await db();
    return new Promise<DraftInfo[]>((resolve, reject) => {
      const tx = connection.transaction("drafts", "readonly"),
        request = tx.objectStore("drafts").index("owner").openCursor(IDBKeyRange.only(owner)),
        items: DraftInfo[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const parsed = DraftSchema.safeParse(cursor.value);
        if (parsed.success)
          items.push({
            id: parsed.data.id,
            title: parsed.data.workspace.title,
            dirty: parsed.data.dirty,
          });
        cursor.continue();
      };
      tx.oncomplete = () => resolve(items);
      tx.onerror = () => reject(new Error("draft_unavailable"));
    });
  },
  async write(owner, draft) {
    const value = DraftSchema.parse(draft),
      connection = await db();
    return new Promise<void>((resolve, reject) => {
      const tx = connection.transaction(["drafts", "current"], "readwrite");
      tx.objectStore("drafts").put({ ...value, owner });
      tx.objectStore("current").put(value.id, owner);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("draft_unavailable"));
      tx.onabort = () => reject(new Error("draft_unavailable"));
    });
  },
};
