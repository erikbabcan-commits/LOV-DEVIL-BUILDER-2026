import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { INTENT_PROMPT_VERSION, INTENT_VARIANT_VERSION, type IntentPromptVersion } from './intent';

const MAX_POLICY_BYTES = 2048;
const Policy = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  variantBasisPoints: z.number().int().min(0).max(10_000),
}).strict();

export function readIntentPolicyPath(env: Readonly<Record<string, string | undefined>>) {
  const file = env.FORGE_INTENT_POLICY_FILE;
  if (file && (!isAbsolute(file) || file.includes('\0'))) {
    throw new Error('FORGE_INTENT_POLICY_FILE must be an absolute file path.');
  }
  return file || undefined;
}

/** Resolve the operator's snapshot for one authenticated auto-mode run. */
export async function selectIntentPrompt(file: string, userId: string): Promise<IntentPromptVersion> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) return INTENT_PROMPT_VERSION;
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_POLICY_BYTES) return INTENT_PROMPT_VERSION;
    const policy = Policy.safeParse(JSON.parse(buffer.toString('utf8', 0, offset)));
    if (!policy.success) return INTENT_PROMPT_VERSION;
    const { experimentId, variantBasisPoints } = policy.data;
    const bucket = createHash('sha256')
      .update(JSON.stringify([experimentId, userId]))
      .digest()
      .readUInt32BE(0) % 10_000;
    return bucket < variantBasisPoints ? INTENT_VARIANT_VERSION : INTENT_PROMPT_VERSION;
  } catch {
    return INTENT_PROMPT_VERSION;
  } finally {
    await handle?.close().catch(() => {});
  }
}
