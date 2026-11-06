export { ExportRequestError } from "../../src/lib/github-export";
export async function listExportProjects() { return { projects: [{ id: "fixture-project", title: "Testovací uložený projekt", revision: 3 }], nextCursor: null }; }
export async function loadExportProject() { return { id: "fixture-project", revision: 3, workspace: { title: "Testovací uložený projekt", snapshots: [{ id: "old", v: 1 }, { id: "latest", v: 2 }] } }; }
// Disposable synthetic provider state, never part of the product overlay.
const key = "qa-only:github-provider";
let job = { requestId: "9553d200-294f-445e-94b8-c29f419da38a", fingerprint: "ab".repeat(32), username: "fixture-user", repoName: "forge-test", status: "prepared", result: null as unknown };
try { const saved = sessionStorage.getItem(key); if (saved) job = JSON.parse(saved); } catch { /* disposable fixture */ }
const save = () => sessionStorage.setItem(key, JSON.stringify(job));
export async function prepareGitHubExport(_token: string, body: { requestId: string; repoName: string }) {
  job = { ...job, requestId: body.requestId, repoName: body.repoName, status: "prepared", result: null };
  save(); return reviewGitHubExport();
}
export async function reviewGitHubExport() {
  return { ...job, username: "fixture-user", visibility: "public", title: "Testovací uložený projekt", version: 1, selection: { projectId: "fixture-project", snapshotId: "old", expectedRevision: 3 }, files: [{ path: "package.json", bytes: 520 }, { path: "src/main.tsx", bytes: 1650 }, { path: "src/styles.css", bytes: 820 }] };
}
export async function updateGitHubExport(_token: string, action: string, body: { requestId: string }) {
  if (action === "cancel") job = { ...job, status: "cancelled", result: null };
  const repository = { repositoryId: 99, repoFullName: `fixture-user/${job.repoName}`, repoUrl: `https://github.com/fixture-user/${job.repoName}` };
  if (action === "confirm" && new URL(location.href).searchParams.get("export") === "recovery") job = { ...job, status: "failed", result: { ok: false, error: "github_write_failed", repository } };
  else if (action === "confirm" || action === "reconcile") job = { ...job, status: "succeeded", result: { ok: true, ...repository, commitSha: "a".repeat(40), filesUploaded: 3 } };
  save(); return { ...job, requestId: body.requestId };
}
