import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DbLike } from '../db/pool';

export interface InstantShareRow {
  share_id: string;
  project_id: string;
  title: string;
  html: string;
  created_at: Date;
  updated_at: Date;
  views_count: number;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateShareId(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = 'sh_';
  for (let i = 0; i < 10; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

const memoryShares = new Map<string, InstantShareRow>();

export function shareRouter(db?: DbLike | null, allow: (key: string) => boolean = () => true) {
  const router = new Hono();

  // Limit body size na 10MB pre veľké projekty
  router.use('/api/share/*', bodyLimit({ maxSize: 10_000_000, onError: c => c.json({ error: 'payload_too_large' }, 413) }));

  // 1. POST /api/share/create — vytvorenie alebo aktualizácia zdieľaného odkazu
  router.post('/api/share/create', async c => {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for') || 'anon';
    if (!allow('share_create:' + ip)) {
      return c.json({ error: 'rate_limit' }, 429);
    }

    let body: { projectId?: string; title?: string; html?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const html = (body.html || '').trim();
    if (!html) {
      return c.json({ error: 'html_required' }, 400);
    }

    const projectId = (body.projectId || '').trim() || 'anon-' + Date.now();
    const title = (body.title || '').trim() || 'VORKEI Aplikácia';

    let shareId = generateShareId();
    if (db) {
      try {
        const existing = await db.query(
          'SELECT share_id FROM public_instant_shares WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1',
          [projectId]
        );
        if (existing.rows.length > 0) {
          shareId = (existing.rows[0] as { share_id: string }).share_id;
          await db.query(
            'UPDATE public_instant_shares SET title = $1, html = $2, updated_at = now() WHERE share_id = $3',
            [title, html, shareId]
          );
        } else {
          await db.query(
            'INSERT INTO public_instant_shares (share_id, project_id, title, html, created_at, updated_at, views_count) VALUES ($1, $2, $3, $4, now(), now(), 0)',
            [shareId, projectId, title, html]
          );
        }
      } catch (err) {
        console.error('[ShareRouter] Postgres share write failed, using memory fallback:', err);
        memoryShares.set(shareId, {
          share_id: shareId,
          project_id: projectId,
          title,
          html,
          created_at: new Date(),
          updated_at: new Date(),
          views_count: 0
        });
      }
    } else {
      // Memory fallback
      for (const [id, row] of memoryShares.entries()) {
        if (row.project_id === projectId) {
          shareId = id;
          break;
        }
      }
      memoryShares.set(shareId, {
        share_id: shareId,
        project_id: projectId,
        title,
        html,
        created_at: new Date(),
        updated_at: new Date(),
        views_count: 0
      });
    }

    const host = c.req.header('host') || 'lov.vorkei.com';
    const proto = c.req.header('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
    const shareUrl = `${proto}://${host}/p/${shareId}`;

    return c.json({
      ok: true,
      shareId,
      shareUrl,
      title
    });
  });

  // 2. GET /api/share/:shareId — získanie detailu zdieľaného projektu
  router.get('/api/share/:shareId', async c => {
    const shareId = c.req.param('shareId');
    if (!shareId || !/^[a-zA-Z0-9_-]{3,64}$/.test(shareId)) {
      return c.json({ error: 'invalid_share_id' }, 400);
    }

    let row: InstantShareRow | null = null;
    if (db) {
      try {
        const res = await db.query(
          'SELECT share_id, project_id, title, html, created_at, updated_at, views_count FROM public_instant_shares WHERE share_id = $1',
          [shareId]
        );
        if (res.rows.length) {
          row = res.rows[0] as InstantShareRow;
          db.query('UPDATE public_instant_shares SET views_count = views_count + 1 WHERE share_id = $1', [shareId]).catch(() => {});
        }
      } catch (err) {
        console.error('[ShareRouter] Postgres share read failed, checking memory:', err);
      }
    }

    if (!row && memoryShares.has(shareId)) {
      row = memoryShares.get(shareId)!;
      row.views_count++;
    }

    if (!row) {
      return c.json({ error: 'share_not_found' }, 404);
    }

    return c.json({
      ok: true,
      shareId: row.share_id,
      projectId: row.project_id,
      title: row.title,
      html: row.html,
      createdAt: row.created_at,
      viewsCount: Number(row.views_count) + 1
    });
  });

  // 3. GET /p/:shareId — Standalone Fullscreen verejný náhľad pre klientov bez prihlasovania
  router.get('/p/:shareId', async c => {
    const shareId = c.req.param('shareId');
    if (!shareId || !/^[a-zA-Z0-9_-]{3,64}$/.test(shareId)) {
      return c.text('Neplatný formát odkazu.', 400);
    }

    try {
      let row: InstantShareRow | null = null;
      if (db) {
        try {
          const res = await db.query(
            'SELECT share_id, project_id, title, html, created_at, views_count FROM public_instant_shares WHERE share_id = $1',
            [shareId]
          );
          if (res.rows.length) {
            row = res.rows[0] as InstantShareRow;
            db.query('UPDATE public_instant_shares SET views_count = views_count + 1 WHERE share_id = $1', [shareId]).catch(() => {});
          }
        } catch (err) {
          console.error('[ShareRouter] Postgres share page read failed, checking memory:', err);
        }
      }

      if (!row && memoryShares.has(shareId)) {
        row = memoryShares.get(shareId)!;
        row.views_count++;
      }

      if (!row) {
        return c.html(`<!DOCTYPE html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Odkaz nenájdený · VORKEI</title>
  <style>
    body { background: #0c0d10; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #18191e; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px; max-width: 440px; text-align: center; }
    h2 { margin-top: 0; color: #fb7185; }
    p { color: #a1a1aa; font-size: 14px; line-height: 1.5; }
    a { display: inline-block; margin-top: 16px; background: #27272a; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <h2>404 · Náhľad nenájdený</h2>
    <p>Tento verejný odkaz na projekt buď neexistuje, alebo bol nahradený novou verziou.</p>
    <a href="/">Prejsť do VORKEI Builder</a>
  </div>
</body>
</html>`, 404);
      }

      const isRaw = c.req.query('raw') === '1';
      if (isRaw) {
        c.header('Content-Type', 'text/html; charset=utf-8');
        c.header('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https: blob:;");
        return c.body(row.html);
      }

      const escapedTitle = escapeHtml(row.title);
      const host = c.req.header('host') || 'lov.vorkei.com';
      const homeUrl = (host.includes('localhost') ? 'http://' : 'https://') + host;

      const pageHtml = `<!DOCTYPE html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>${escapedTitle} · VORKEI Client Preview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #090a0f;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #frame-container {
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      background: #090a0f;
    }
    #client-preview-frame {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      background: #ffffff;
      transition: width 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s ease;
    }
    #client-preview-frame.mode-mobile {
      width: 390px;
      max-width: 100%;
      height: min(844px, calc(100vh - 60px));
      border-radius: 28px;
      border: 8px solid #1f2028;
      box-shadow: 0 25px 60px rgba(0,0,0,0.85), 0 0 30px rgba(74, 222, 128, 0.15);
    }
    #client-preview-frame.mode-tablet {
      width: 768px;
      max-width: 100%;
      height: min(1024px, calc(100vh - 60px));
      border-radius: 20px;
      border: 6px solid #1f2028;
      box-shadow: 0 25px 60px rgba(0,0,0,0.85);
    }
    #vorkei-watermark {
      position: fixed;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 16px;
      background: rgba(18, 19, 24, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.12);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-radius: 9999px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6), 0 0 15px rgba(74, 222, 128, 0.12);
      color: #fafafa;
      font-size: 12px;
      user-select: none;
    }
    .watermark-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #e4e4e7;
      text-decoration: none;
      font-weight: 500;
      transition: color 0.15s ease;
    }
    .watermark-link:hover {
      color: #4ade80;
    }
    .bolt {
      color: #4ade80;
      font-weight: 700;
    }
    .vp-toggles {
      display: flex;
      align-items: center;
      gap: 4px;
      border-left: 1px solid rgba(255, 255, 255, 0.15);
      padding-left: 10px;
    }
    .vp-btn {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.12);
      color: #a1a1aa;
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .vp-btn.active, .vp-btn:hover {
      color: #ffffff;
      border-color: #4ade80;
      background: rgba(74, 222, 128, 0.12);
    }
    @media (max-width: 600px) {
      #vorkei-watermark {
        bottom: 8px;
        padding: 5px 12px;
        font-size: 11px;
      }
      .vp-toggles {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div id="frame-container">
    <iframe id="client-preview-frame" sandbox="allow-scripts allow-forms allow-popups" title="${escapedTitle}"></iframe>
  </div>

  <div id="vorkei-watermark">
    <a class="watermark-link" href="${homeUrl}" target="_blank" rel="noopener noreferrer">
      <span class="bolt">⚡</span> Built with <strong>VORKEI AI</strong> · Postav si vlastnú appku →
    </a>
    <div class="vp-toggles">
      <button type="button" class="vp-btn active" id="btn-desktop" onclick="setVp('desktop')">Desktop</button>
      <button type="button" class="vp-btn" id="btn-tablet" onclick="setVp('tablet')">Tablet</button>
      <button type="button" class="vp-btn" id="btn-mobile" onclick="setVp('mobile')">Mobile</button>
    </div>
  </div>

  <script>
    var rawHtml = ${JSON.stringify(row.html)};
    var iframe = document.getElementById('client-preview-frame');
    iframe.srcdoc = rawHtml;

    function setVp(mode) {
      iframe.className = mode === 'desktop' ? '' : 'mode-' + mode;
      document.getElementById('btn-desktop').classList.toggle('active', mode === 'desktop');
      document.getElementById('btn-tablet').classList.toggle('active', mode === 'tablet');
      document.getElementById('btn-mobile').classList.toggle('active', mode === 'mobile');
    }
  </script>
</body>
</html>`;

      c.header('Content-Type', 'text/html; charset=utf-8');
      c.header('Content-Security-Policy', "frame-ancestors 'self' https: http:;");
      return c.html(pageHtml);
    } catch (err) {
      console.error('[ShareRouter] Chyba pri servovaní share stránky:', err);
      return c.text('Nastala chyba pri načítaní verejného náhľadu.', 500);
    }
  });

  return router;
}
