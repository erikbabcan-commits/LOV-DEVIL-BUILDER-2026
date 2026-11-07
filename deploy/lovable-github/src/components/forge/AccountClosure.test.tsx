import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { honoFetch } from "@/lib/hono-client";
import { AccountClosure } from "./AccountClosure";

vi.mock("@/lib/hono-client", () => ({ honoFetch: vi.fn() }));
const request = vi.mocked(honoFetch);
const props = { cloudUserId: "cloud-alice", honoUserId: "alice", accessToken: "fixture" };
const none = { accountId: "alice", state: "none" };

afterEach(() => {
  cleanup();
  request.mockReset();
});

it("requires explicit confirmation, retries with the same ID and cancels only that request", async () => {
  request
    .mockResolvedValueOnce(Response.json(none))
    .mockResolvedValueOnce(Response.json({ error: "temporary" }, { status: 503 }))
    .mockImplementationOnce(async (_path, init) =>
      Response.json({
        accountId: "alice",
        state: "pending",
        eligibleAt: "2026-12-07T20:00:00.000Z",
        requestId: (init?.body as { requestId: string }).requestId,
      }),
    )
    .mockResolvedValueOnce(Response.json(none));
  render(<AccountClosure {...props} />);
  fireEvent.click(screen.getByText("Zrušenie účtu"));
  const submit = await screen.findByRole("button", { name: "Podať žiadosť" });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(submit);
  expect(await screen.findByRole("alert")).toHaveTextContent("Skús to znova");
  fireEvent.click(submit);
  const cancel = await screen.findByRole("button", { name: "Odvolať žiadosť" });
  fireEvent.click(cancel);
  await screen.findByText("Žiadosť bola odvolaná.");
  const id = (request.mock.calls[1]?.[1]?.body as { requestId: string }).requestId;
  expect(request.mock.calls.slice(1).map(([path, init]) => [path, init?.body])).toEqual([
    ["account/closure", { requestId: id, confirmed: true }],
    ["account/closure", { requestId: id, confirmed: true }],
    ["account/closure/cancel", { requestId: id }],
  ]);
  expect(
    request.mock.calls.every(
      ([, init]) =>
        init?.expectedUserId === props.cloudUserId &&
        init.expectedAccessToken === props.accessToken,
    ),
  ).toBe(true);
});

it("aborts a pending state read when the account panel closes", async () => {
  let resolve!: (response: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((finish) => {
        resolve = finish;
      }),
  );
  const view = render(<AccountClosure {...props} />);
  fireEvent.click(screen.getByText("Zrušenie účtu"));
  await screen.findByText("Overujem stav žiadosti…");
  const signal = request.mock.calls[0]?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json(none)));
});
