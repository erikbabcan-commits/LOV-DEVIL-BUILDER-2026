import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { honoFetch } from "@/lib/hono-client";
import { AccountDataExport } from "./AccountDataExport";

vi.mock("@/lib/hono-client", () => ({ honoFetch: vi.fn() }));
const request = vi.mocked(honoFetch);
const props = { cloudUserId: "cloud-alice", honoUserId: "alice", accessToken: "fixture" };
const response = (accountId: string, section: string, nextCursor: string | null) =>
  Response.json({ version: 1, accountId, section, nextCursor, records: [{ id: "project" }] });

function setupDownload() {
  const create = vi.fn(() => "blob:fixture");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    },
  );
  const filenames: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filenames.push(this.download);
  });
  return { create, filenames };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  request.mockReset();
});

it("downloads each page on demand and retries the same cursor after failure", async () => {
  const { filenames } = setupDownload();
  request
    .mockResolvedValueOnce(response("alice", "projects", "cHJvamVjdA"))
    .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
    .mockResolvedValueOnce(response("alice", "projects", null));
  render(<AccountDataExport {...props} />);
  fireEvent.click(screen.getByText("Údaje účtu"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "projects" } });
  fireEvent.click(screen.getByRole("button", { name: "Stiahnuť JSON" }));
  const next = await screen.findByRole("button", { name: "Stiahnuť ďalšiu časť" });
  expect(filenames).toEqual(["vorkei-projects-1.json"]);
  fireEvent.click(next);
  expect(await screen.findByRole("alert")).toHaveTextContent("Údaje sa nepodarilo stiahnuť.");
  expect(filenames).toEqual(["vorkei-projects-1.json"]);
  fireEvent.click(screen.getByRole("button", { name: "Stiahnuť ďalšiu časť" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Posledná časť");
  expect(filenames).toEqual(["vorkei-projects-1.json", "vorkei-projects-2.json"]);
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "account/export/projects",
    "account/export/projects/cHJvamVjdA",
    "account/export/projects/cHJvamVjdA",
  ]);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    expectedUserId: "cloud-alice",
    expectedAccessToken: "fixture",
  });
});

it("discards the response for a different account and cancels an in-flight download on unmount", async () => {
  const { create } = setupDownload();
  request.mockResolvedValueOnce(response("bob", "profile", null));
  let finish!: (value: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<AccountDataExport {...props} />);
  fireEvent.click(screen.getByText("Údaje účtu"));
  fireEvent.click(screen.getByRole("button", { name: "Stiahnuť JSON" }));
  await screen.findByRole("alert");
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stiahnuť JSON" }));
  const signal = request.mock.calls[1]?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(response("alice", "profile", null)));
  expect(create).not.toHaveBeenCalled();
});
