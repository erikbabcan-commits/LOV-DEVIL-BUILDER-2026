import { Hono, type Context } from "hono";
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
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return next();
  });
  async function serve(c: Context, id: string, query: string) {
    if (new URL(c.req.url).search) return c.notFound();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      return c.notFound();
    try {
      const row = (await db.query(query, [id])).rows[0];
      if (!row) return c.notFound();
      const bytes = await artifacts.read(
        row.artifact_id,
        row.artifact_sha256,
        Number(row.artifact_bytes),
      );
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Content-Length", String(bytes.byteLength));
      return new Response(c.req.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: c.res.headers,
      });
    } catch {
      return c.notFound();
    }
  }
  app.on(["GET", "HEAD"], "/p/:artifactId/", (c) => serve(c, c.req.param("artifactId"),
    `SELECT artifact_id, artifact_sha256, artifact_bytes FROM publish_jobs
     WHERE artifact_id=$1 AND state='published' AND withdrawn_at IS NULL`));
  app.on(["GET", "HEAD"], "/p/live/:aliasId/", (c) => serve(c, c.req.param("aliasId"),
    `SELECT j.artifact_id, j.artifact_sha256, j.artifact_bytes
     FROM publish_live_addresses AS a
     JOIN builder_projects AS p USING (owner_id, project_id)
     JOIN publish_jobs AS j
       ON j.owner_id=a.owner_id AND j.project_id=a.project_id AND j.request_id=a.request_id
     WHERE a.alias_id=$1 AND p.deleted_at IS NULL AND j.state='published' AND j.withdrawn_at IS NULL`));
  return app;
}
