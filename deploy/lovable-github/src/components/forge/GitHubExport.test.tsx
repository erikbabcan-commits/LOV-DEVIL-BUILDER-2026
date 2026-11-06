import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubExport } from "./GitHubExport";
import { ExportRequestError } from "@/lib/github-export";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  prepare: vi.fn(),
  review: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/github-export", async (original) => ({
  ...(await original<typeof import("@/lib/github-export")>()),
  listExportProjects: api.list,
  loadExportProject: api.load,
  prepareGitHubExport: api.prepare,
  reviewGitHubExport: api.review,
  updateGitHubExport: api.update,
}));
const requestId = "9553d200-294f-445e-94b8-c29f419da38a",
  fingerprint = "ab".repeat(32);
const job = {
  username: "fixture",
  requestId,
  fingerprint,
  repoName: "export",
  status: "prepared" as const,
  result: null,
};
beforeEach(() => {
  sessionStorage.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.list.mockResolvedValue({
    projects: [{ id: "server-project", title: "Uložený projekt", revision: 7 }],
    nextCursor: null,
  });
  api.load.mockResolvedValue({
    id: "server-project",
    revision: 7,
    workspace: {
      title: "Uložený projekt",
      snapshots: [
        { id: "old-version", v: 1 },
        { id: "latest-version", v: 2 },
      ],
    },
  });
  const review = {
    ...job,
    username: "fixture",
    visibility: "public" as const,
    title: "Uložený projekt",
    version: 1,
    selection: { projectId: "server-project", snapshotId: "old-version", expectedRevision: 7 },
    files: [{ path: "src/main.tsx", bytes: 42 }],
  };
  api.prepare.mockResolvedValue(review);
  api.review.mockResolvedValue(review);
  api.update.mockResolvedValue({
    ...job,
    status: "succeeded",
    result: {
      ok: true,
      repositoryId: 99,
      repoFullName: "fixture/export",
      repoUrl: "https://github.com/fixture/export",
      commitSha: "a".repeat(40),
      filesUploaded: 1,
    },
  });
});
afterEach(() => cleanup());
async function openAndReview() {
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  await screen.findByRole("option", { name: "Uložený projekt" });
  fireEvent.change(screen.getByLabelText("Uložený projekt"), {
    target: { value: "server-project" },
  });
  await screen.findByLabelText("Verzia");
  fireEvent.change(screen.getByLabelText("Verzia"), { target: { value: "old-version" } });
  fireEvent.change(screen.getByLabelText("Názov nového repozitára"), {
    target: { value: "export" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Skontrolovať export" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Skontrolovať export" }));
  await screen.findByRole("list", { name: "Exportované súbory" });
}
it("selects real server revision and historical snapshot; publication requires an unchecked-by-default consent", async () => {
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  await openAndReview();
  expect(api.prepare).toHaveBeenCalledWith(
    "alice",
    expect.objectContaining({
      repoName: "export",
      selection: { projectId: "server-project", snapshotId: "old-version", expectedRevision: 7 },
    }),
    expect.any(AbortSignal),
  );
  const publish = screen.getByRole("button", { name: "Vytvoriť verejný repozitár" });
  expect(screen.getByText("Uložený projekt · Verzia 1")).toBeTruthy();
  expect(publish).toBeDisabled();
  expect(api.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(publish);
  await screen.findByRole("link", { name: "Otvoriť repozitár" });
  expect(api.update).toHaveBeenCalledExactlyOnceWith(
    "alice",
    "confirm",
    { requestId, fingerprint, publicConfirmed: true },
    expect.any(AbortSignal),
  );
  expect(sessionStorage.getItem("forge:github-export:alice")).toBe(requestId);
  expect(JSON.stringify(Object.values(sessionStorage))).not.toContain("src/main.tsx");
});
it("checks the same job after a timeout and never automatically submits another write", async () => {
  api.update
    .mockRejectedValueOnce(new Error("Over stav exportu."))
    .mockResolvedValue({ ...job, status: "running" });
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  await openAndReview();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Vytvoriť verejný repozitár" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Overiť stav exportu" }));
  await waitFor(() =>
    expect(api.update).toHaveBeenLastCalledWith(
      "alice",
      "status",
      { requestId },
      expect.any(AbortSignal),
    ),
  );
  expect(api.update.mock.calls.filter((call) => call[1] === "confirm")).toHaveLength(1);
});
it("recovers a request UUID after remount without repeating publication", async () => {
  sessionStorage.setItem("forge:github-export:alice", requestId);
  render(<GitHubExport token="alice" accountId="alice" username="different-current-login" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  await screen.findByRole("link", { name: "Otvoriť repozitár" });
  expect(screen.getByText("fixture/export · Verejné")).toBeTruthy();
  expect(api.list).not.toHaveBeenCalled();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.update).toHaveBeenCalledExactlyOnceWith(
    "alice",
    "status",
    { requestId },
    expect.any(AbortSignal),
  );
});
it("uses a separate recovery key for another account", async () => {
  sessionStorage.setItem("forge:github-export:alice", requestId);
  render(<GitHubExport token="bob" accountId="bob" username="bob-github" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  await screen.findByRole("option", { name: "Uložený projekt" });
  expect(api.list).toHaveBeenCalledWith("bob", "", expect.any(AbortSignal));
  expect(api.update).not.toHaveBeenCalled();
});
it("restores a prepared file review and requires fresh consent after remount", async () => {
  sessionStorage.setItem("forge:github-export:alice", requestId);
  api.update.mockResolvedValue(job);
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  await screen.findByRole("button", { name: "Obnoviť kontrolu súborov" });
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Obnoviť kontrolu súborov" }));
  await screen.findByRole("list", { name: "Exportované súbory" });
  expect(screen.getByText("Uložený projekt · Verzia 1")).toBeTruthy();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Vytvoriť verejný repozitár" })).toBeDisabled();
  expect(api.review).toHaveBeenCalledExactlyOnceWith("alice", requestId, expect.any(AbortSignal));
  expect(api.update.mock.calls.filter((call) => call[1] === "confirm")).toHaveLength(0);
});
it("cancels an unconfirmed review on the server before offering a new export", async () => {
  api.update.mockResolvedValue({ ...job, status: "cancelled" });
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  await openAndReview();
  expect(screen.queryByRole("button", { name: "Nový export" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Zrušiť prípravu" }));
  await screen.findByText(/Príprava je zrušená/);
  expect(api.update).toHaveBeenCalledExactlyOnceWith(
    "alice",
    "cancel",
    { requestId, fingerprint },
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Nový export" }));
  await screen.findByRole("button", { name: "Skontrolovať export" });
  expect(sessionStorage.getItem("forge:github-export:alice")).toBeNull();
});
it("offers status checking when publication wins a cancellation race", async () => {
  api.update.mockRejectedValue(
    new ExportRequestError("export_already_started", "Export sa už začal."),
  );
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  await openAndReview();
  fireEvent.click(screen.getByRole("button", { name: "Zrušiť prípravu" }));
  await screen.findByRole("button", { name: "Overiť stav exportu" });
  expect(screen.queryByRole("button", { name: "Nový export" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("shows an expired proposal as terminal without retrying publication", async () => {
  sessionStorage.setItem("forge:github-export:alice", requestId);
  api.update.mockResolvedValue({ ...job, status: "expired" });
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  await screen.findByText(/Príprava vypršala/);
  expect(screen.getByRole("button", { name: "Nový export" })).toBeTruthy();
  expect(api.review).not.toHaveBeenCalled();
  expect(api.prepare).not.toHaveBeenCalled();
});
it("explicitly reconciles an uncertain result without another publication request", async () => {
  sessionStorage.setItem("forge:github-export:alice", requestId);
  const success = await api.update();
  api.update.mockReset();
  api.update
    .mockResolvedValueOnce({
      ...job,
      status: "failed",
      result: { ok: false, error: "github_write_failed" },
    })
    .mockResolvedValueOnce(success);
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  await screen.findByRole("button", { name: "Overiť výsledok na GitHube" });
  fireEvent.click(screen.getByRole("button", { name: "Overiť výsledok na GitHube" }));
  await screen.findByRole("link", { name: "Otvoriť repozitár" });
  expect(api.update).toHaveBeenLastCalledWith(
    "alice",
    "reconcile",
    { requestId },
    expect.any(AbortSignal),
  );
  expect(api.update.mock.calls.some((call) => call[1] === "confirm")).toBe(false);
  expect(api.prepare).not.toHaveBeenCalled();
});
it("keeps an unverified running export recoverable after a read-only check fails", async () => {
  sessionStorage.setItem("forge:github-export:alice", requestId);
  api.update
    .mockResolvedValueOnce({ ...job, status: "running" })
    .mockRejectedValueOnce(
      new ExportRequestError("export_not_verified", "Výsledok zatiaľ nie je overený."),
    );
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  await screen.findByRole("button", { name: "Overiť výsledok na GitHube" });
  fireEvent.click(screen.getByRole("button", { name: "Overiť výsledok na GitHube" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Overiť stav exportu" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Nový export" })).toBeNull();
  expect(api.update.mock.calls.some((call) => call[1] === "confirm")).toBe(false);
});
it("offers the server-verified partial repository for manual inspection after a failed export", async () => {
  sessionStorage.setItem("forge:github-export:alice", requestId);
  api.update.mockResolvedValue({
    ...job,
    status: "failed",
    result: {
      ok: false,
      error: "github_write_failed",
      repository: {
        repositoryId: 99,
        repoFullName: "fixture/export",
        repoUrl: "https://github.com/fixture/export",
      },
    },
  });
  render(<GitHubExport token="alice" accountId="alice" username="fixture" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportovať verziu" }));
  expect(
    await screen.findByRole("link", { name: "Skontrolovať vytvorený repozitár" }),
  ).toHaveAttribute("href", "https://github.com/fixture/export");
  expect(api.update.mock.calls.some((call) => call[1] !== "status")).toBe(false);
  expect(api.prepare).not.toHaveBeenCalled();
});
