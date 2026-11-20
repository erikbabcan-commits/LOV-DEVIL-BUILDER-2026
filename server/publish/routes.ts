import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { PublishProjectVersion, PublishPromotion, PublishRequest, PublishWithdrawal } from "../../shared/publish";
import { PublishRollbackRequest } from "./rollback";
import { publishBaseDomain, type DnsLookup } from "./router";
import { getUserFromContext } from "../auth/middleware";
import { PublishService, PublishError } from "./service";
/** Mount authenticated publication, status, promotion and owner withdrawal operations. */
export function publishRouter(
  service: PublishService | null,
  allow: (key: string) => boolean,
  options: { dnsLookup?: DnsLookup } = {},
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
    try {
      const value = await service.start(user.id, parsed.data);
      return c.json(value, value.state === "building" ? 201 : 200);
    } catch (error) {
      if (error instanceof PublishError && error.code === "publish_capacity")
        return c.json({ error: "publish_quota_exceeded" }, 413);
      throw error;
    }
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
  for (const endpoint of ["latest", "releases", "live"] as const) {
    router.get(`/api/publish/project/:projectId/${endpoint}`, async (c) => {
      const user = getUserFromContext(c);
      if (!user) return c.json({ error: "unauthenticated" }, 401);
      if (!service) return c.json({ error: "publish_disabled" }, 503);
      if (new URL(c.req.url).search)
        return c.json({ error: "invalid_query" }, 400);
      const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
      if (!project.success)
        return c.json({ error: "publish_invalid_request" }, 400);
      if (!allow("publish-status:" + user.id))
        return c.json({ error: "rate_limit" }, 429);
      if (endpoint === "releases") return c.json(await service.recentPublications(user.id, project.data));
      if (endpoint === "live") return c.json(await service.liveAddress(user.id, project.data));
      return c.json(await service.latestPublished(user.id, project.data));
    });
  }
  router.post("/api/publish/project/:projectId/live", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    const selection = PublishPromotion.safeParse(await c.req.json().catch(() => null));
    if (!project.success || !selection.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-live:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.promote(user.id, project.data, selection.data));
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
    try {
      const progress = await service.progress(user.id, c.req.param("requestId"));
      if (progress.stage) c.header("X-LOV-Publish-Stage", progress.stage);
      return c.json(progress.job);
    } catch (error) {
      if (error instanceof PublishError && error.code === "publish_not_found")
        return c.json({ error: "not_found" }, 404);
      throw error;
    }
  });
  router.post("/api/publish/:requestId/withdraw", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const requestId = z.uuid().safeParse(c.req.param("requestId"));
    const consent = PublishWithdrawal.safeParse(await c.req.json().catch(() => null));
    if (!requestId.success || !consent.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-withdraw:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.withdraw(user.id, requestId.data));
  });

  router.get("/api/publish/project/:projectId/slug", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    if (!project.success) return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-slug:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    const slug = await service.getProjectSlug(user.id, project.data);
    return c.json({ slug });
  });
  router.post("/api/publish/project/:projectId/slug", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    if (!project.success) return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-slug:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    const body = z
      .object({ seed: z.string().max(200).optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "publish_invalid_request" }, 400);
    return c.json(await service.ensureProjectSlug(user.id, project.data, body.data.seed));
  });
  router.get("/api/publish/project/:projectId/domains", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    if (!project.success) return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-domain:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.listProjectDomains(user.id, project.data));
  });
  router.post("/api/publish/project/:projectId/domains", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    const body = z
      .object({ domain: z.string().min(1).max(254) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!project.success || !body.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-domain:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    return c.json(
      await service.registerCustomDomain(user.id, project.data, body.data.domain),
    );
  });
  router.delete("/api/publish/project/:projectId/domains/:domain", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    const domain = z.string().min(1).max(254).safeParse(c.req.param("domain"));
    if (!project.success || !domain.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-domain:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.deleteCustomDomain(user.id, project.data, domain.data));
  });
  router.post("/api/publish/project/:projectId/domains/verify", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    const body = z
      .object({ domain: z.string().min(1).max(254) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!project.success || !body.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-domain:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    const lookup = options.dnsLookup;
    if (!lookup) return c.json({ error: "publish_dns_unavailable" }, 503);
    const status = await service.verifyProjectDomain(
      user.id,
      body.data.domain,
      lookup,
      publishBaseDomain(),
    );
    return c.json({ domain: body.data.domain.toLowerCase(), status });
  });
  router.get("/api/publish/project/:projectId/versions", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    if (!project.success) return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-status:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    return c.json(await service.listVersions(user.id, project.data));
  });
  router.post("/api/publish/project/:projectId/rollback", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!service) return c.json({ error: "publish_disabled" }, 503);
    if (new URL(c.req.url).search) return c.json({ error: "invalid_query" }, 400);
    const project = PublishRequest.shape.projectId.safeParse(c.req.param("projectId"));
    const selection = PublishRollbackRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!project.success || !selection.success)
      return c.json({ error: "publish_invalid_request" }, 400);
    if (!allow("publish-rollback:" + user.id)) return c.json({ error: "rate_limit" }, 429);
    const result = await service.rollback(user.id, project.data, selection.data);
    return c.json({ ...result.address, elapsedMs: result.elapsedMs });
  });
  return router;
}
