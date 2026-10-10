/* M4: Server-side export routes
   ZIP Export: Server validates export requests (download happens client-side)
   GitHub Export: Now handled by github.ts with real OAuth
   
   Security: All sensitive operations happen on the server
   - GitHub tokens NEVER exposed to client
   - Path validation on server
   - Rate limiting
*/

import { Hono } from 'hono';
import { z } from 'zod';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';

const exportRouter = new Hono();

/* ---------- ZIP Export Validation (server-side) ---------- */

const ZipExportSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1).max(255),
    content: z.string().max(10_000_000), // 10MB per file
  })).max(200), // Max 200 files
});

exportRouter.post('/api/export/validate', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ZipExportSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid export data' } as const, 400);
    }
    
    const { files } = parsed.data;
    
    // Validate paths
    for (const f of files) {
      if (!isSafePath(f.path)) {
        return c.json({ ok: false, error: `Unsafe path: ${f.path}` } as const, 400);
      }
    }
    
    // Validate size
    const size = withinSizeLimits(files.map(f => ({ path: f.path, content: f.content })));
    if (!size.ok) {
      return c.json({ ok: false, error: size.reason } as const, 400);
    }
    
    return c.json({ ok: true } as const);
  } catch {
    return c.json({ ok: false, error: 'Invalid request' } as const, 400);
  }
});

export { exportRouter };
