import { Hono } from "hono";
import type { DbLike } from "../db/pool";
import { ArtifactStore } from "./artifacts";
import { validatePublishConfig, type PublishConfig } from "./config";
/** Mount ONLY on the separate public listener. Never mount in the authenticated application. */
export function publicPublishApp(
  config: PublishConfig,
  db: DbLike,
  artifacts = new ArtifactStore(config.artifactDir, config.maxArtifactBytes),
) {
  validatePublishConfig(config);
  const app = new Hono(),
    host = new URL(config.baseUrl).host;
  app.use("*", async (c, next) => {
    if (
      c.req.header("Host") !== host ||
      !["GET", "HEAD"].includes(c.req.method)
    )
      return c.notFound();
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return next();
  });
  app.on(["GET", "HEAD"], "/p/:artifactId/", async (c) => {
    if (new URL(c.req.url).search) return c.notFound();
    const id = c.req.param("artifactId");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      return c.notFound();
    try {
      const row = (
        await db.query(
          "SELECT artifact_sha256,artifact_bytes FROM publish_jobs WHERE artifact_id=$1 AND state='published'",
          [id],
        )
      ).rows[0];
      if (!row) return c.notFound();
      const bytes = await artifacts.read(
        id,
        row.artifact_sha256,
        Number(row.artifact_bytes),
      );
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Content-Length", String(bytes.byteLength));
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(c.req.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: c.res.headers,
      });
    } catch {
      return c.notFound();
    }
  });
  return app;
}
