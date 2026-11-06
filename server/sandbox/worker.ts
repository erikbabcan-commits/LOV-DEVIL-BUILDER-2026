import { buildProject } from './builder';
import { CompileRequestSchema, MAX_INPUT_JSON_BYTES } from './policy';

/** Separate container entrypoint. Never import server/index or dotenv here. */
setTimeout(() => process.exit(124), 18_000);
async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_JSON_BYTES) throw new Error('input limit');
    chunks.push(chunk);
  }
  const { files } = CompileRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const result = await buildProject(files);
  (await import('esbuild')).stop();
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}
main().catch(() => { process.stderr.write('compile worker failed\n', () => process.exit(1)); });
