import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PublishProjectVersion, PublishRequest, PublishWithdrawal } from "../../shared/publish";
import { getUserFromContext } from "../auth/middleware";
import { PublishService, PublishError } from "./service";
export function publishRouter(
  service: PublishService | null,
  allow: (key: string) => boolean,
) {
  const router = new Hono();
  router.use(
    "/api/publish/*",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "publish_input_limit" }, 413),
    }),
  );
  router.use(
    "/api/publish",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "publish_input_limit" }, 413),
    }),
  );
  router.use("/api/publish", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });
  router.use("/api/publish/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });
  router.onError((e, c) =>
    e instanceof PublishError
      ? c.json({ error: e.code }, e.status)
      : c.json({ error: "publish_unavailable" }, 503),
  );
  router.get("/api/publish", async (c) => {
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    return c.json(
      service
        ? await service.ready()
        : {
            enabled: false,
            ready: false,
            reason: "disabled",
            publicOrigin: null,
          },
    );
  });
  router.post("/api/publish", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    if (!allow("publish:" + user.id))
      return c.json({ error: "rate_limit" }, 429);
    const parsed = PublishRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    const value = await service.start(user.id, parsed.data);
    return c.json(value, value.state === "building" ? 202 : 200);
  });
  router.get("/api/publish/project/:projectId/:revision/:snapshotId", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    const revision = c.req.param("revision");
    const version = PublishProjectVersion.safeParse({
      projectId: c.req.param("projectId"),
      expectedRevision: /^[1-9][0-9]{0,9}$/.test(revision) ? Number(revision) : null,
      snapshotId: c.req.param("snapshotId"),
    });
    if (!version.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-status:" + user.id))
      return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.publishedVersion(user.id, version.data));
  });
  router.get("/api/publish/:requestId", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        c.req.param("requestId"),
      )
    )
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-status:" + user.id))
      return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.status(user.id, c.req.param("requestId")));
  });
  router.post("/api/publish/:requestId/withdraw", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const requestId = PublishRequest.shape.requestId.safeParse(c.req.param("requestId"));
    const consent = PublishWithdrawal.safeParse(await c.req.json().catch(() => null));
    if (!requestId.success || !consent.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-withdraw:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.withdraw(user.id, requestId.data));
  });
  return router;
}
