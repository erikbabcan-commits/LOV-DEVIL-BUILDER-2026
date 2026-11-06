import { z } from "zod";
import { GitHubExportJob, GitHubExportReview } from "./github-export-protocol";
export type ExportJob = z.infer<typeof GitHubExportJob>;
export type ExportReview = z.infer<typeof GitHubExportReview>;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const projects = z.object({
  projects: z
    .array(z.object({ id, title: z.string(), revision: z.number().int().positive() }))
    .max(50),
  nextCursor: id.nullable(),
});
const project = z.object({
  id,
  revision: z.number().int().positive(),
  workspace: z.object({
    title: z.string(),
    snapshots: z.array(z.object({ id, v: z.number().int().positive() })).max(100),
  }),
});
export type ExportProject = z.infer<typeof project>;
function checked<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error("Server vrátil neplatnú odpoveď. Skús to znova alebo over stav exportu.");
  return parsed.data;
}
export class ExportRequestError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
async function json(
  path: string,
  token: string,
  body: unknown,
  signal: AbortSignal,
  isExport = false,
) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: isExport ? "same-origin" : "omit",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: unknown };
    const code = typeof error.error === "string" ? error.error : "unavailable";
    const messages: Record<string, string> = {
      project_conflict: "Projekt sa zmenil. Načítaj ho znova.",
      invalid_sources: "Vybraná verzia nemá bezpečné exportovateľné súbory.",
      export_request_conflict:
        "Tento názov alebo pokus je už rezervovaný. Začni nový export s iným názvom.",
      export_expired: "Kontrola exportu vypršala. Začni nový export.",
      export_not_prepared: "Táto príprava už nie je aktívna. Over stav exportu.",
      export_already_started: "Export sa už začal a nemožno ho zrušiť. Over jeho stav.",
      export_recovery_unavailable:
        "Na automatické overenie chýbajú údaje. Pred novým exportom skontroluj repozitár na GitHube alebo kontaktuj podporu.",
      export_not_verified:
        "Výsledok na GitHube sa zatiaľ nezhoduje s exportom. Over pôvodný GitHub účet a skús kontrolu neskôr.",
      github_recovery_unavailable:
        "GitHub sa nepodarilo overiť. Skús kontrolu neskôr; nový export sa nespustil.",
      github_not_connected: "Najprv pripoj GitHub.",
    };
    throw new ExportRequestError(
      code,
      messages[code] ?? "Export momentálne nie je dostupný. Over jeho stav pred ďalším pokusom.",
    );
  }
  return (await response.json()) as unknown;
}
export async function listExportProjects(token: string, cursor: string, signal: AbortSignal) {
  if (cursor && !id.safeParse(cursor).success) throw new Error("Neplatná stránka projektov.");
  return checked(
    projects,
    await json(
      `/api/hono/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
      undefined,
      signal,
    ),
  );
}
export async function loadExportProject(token: string, projectId: string, signal: AbortSignal) {
  id.parse(projectId);
  return checked(
    project,
    await json(`/api/hono/projects/${encodeURIComponent(projectId)}`, token, undefined, signal),
  );
}
export async function prepareGitHubExport(token: string, body: unknown, signal: AbortSignal) {
  return checked(
    GitHubExportReview,
    await json("/api/github-connect/export/prepare", token, body, signal, true),
  );
}
export async function reviewGitHubExport(token: string, requestId: string, signal: AbortSignal) {
  return checked(
    GitHubExportReview,
    await json("/api/github-connect/export/review", token, { requestId }, signal, true),
  );
}
export async function updateGitHubExport(
  token: string,
  action: "confirm" | "status" | "cancel" | "reconcile",
  body: unknown,
  signal: AbortSignal,
) {
  return checked(
    GitHubExportJob,
    await json(`/api/github-connect/export/${action}`, token, body, signal, true),
  );
}
