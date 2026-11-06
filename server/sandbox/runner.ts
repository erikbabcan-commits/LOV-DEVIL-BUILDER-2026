import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DockerCompiler, type CompilerWorker } from './dockerCompiler';
import { CompileQueue } from './queue';
import { asSandboxError } from './errors';
import { CompileRequestSchema, MAX_INPUT_JSON_BYTES, validationFailure } from './policy';

/** Private, authenticated control plane. It never accepts Docker options from a caller. */
export function createRunnerServer(token: string, worker: CompilerWorker = new DockerCompiler(), queue = new CompileQueue()) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('SANDBOX_RUNNER_TOKEN must contain 32–256 safe random characters');
  const expected = Buffer.from('Bearer ' + token);
  let receivingBytes = 0;
  const send = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.setHeader('Connection', 'close'); send(res, 401, { error: 'unauthorized' }); return;
    }
    const abort = new AbortController();
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    let reservedBytes = 0;
    const disconnect = () => { if (!res.writableFinished) abort.abort(); };
    req.once('aborted', disconnect); res.once('close', disconnect);
    try {
      if (req.method === 'GET' && req.url === '/ready') {
        const ready = await worker.ready(); send(res, ready ? 200 : 503, { ready, queue: queue.stats }); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/compile') { send(res, 404, { error: 'not_found' }); return; }
      if (req.headers['content-encoding'] || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        send(res, 415, { error: 'unsupported_media_type' }); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      bodyTimer = setTimeout(() => req.destroy(), 10_000);
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_INPUT_JSON_BYTES || receivingBytes + chunk.length > MAX_INPUT_JSON_BYTES * 2 || chunks.length >= 8192) {
          send(res, 413, { error: 'input_limit' }); req.destroy(); return;
        }
        receivingBytes += chunk.length; reservedBytes += chunk.length;
        chunks.push(chunk);
      }
      clearTimeout(bodyTimer);
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { send(res, 400, { error: 'invalid_json' }); return; }
      chunks.length = 0;
      receivingBytes -= reservedBytes; reservedBytes = 0;
      const parsed = CompileRequestSchema.safeParse(input);
      if (!parsed.success) { send(res, 400, { error: 'invalid_files' }); return; }
      const invalid = validationFailure(parsed.data.files);
      if (invalid) { send(res, 200, invalid); return; }
      const result = await queue.run(signal => worker.compile(parsed.data.files, signal), abort.signal);
      send(res, 200, result);
    } catch (error) {
      const safe = asSandboxError(error); send(res, safe.status, { error: safe.code, message: safe.message });
    } finally {
      clearTimeout(bodyTimer); receivingBytes -= reservedBytes;
      req.removeListener('aborted', disconnect); res.removeListener('close', disconnect);
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  server.maxConnections = 12;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.SANDBOX_RUNNER_TOKEN ?? '';
  const worker = new DockerCompiler(process.env.SANDBOX_WORKER_IMAGE);
  createRunnerServer(token, worker).listen(Number(process.env.SANDBOX_RUNNER_PORT ?? 8790), process.env.SANDBOX_RUNNER_BIND ?? '127.0.0.1');
}
