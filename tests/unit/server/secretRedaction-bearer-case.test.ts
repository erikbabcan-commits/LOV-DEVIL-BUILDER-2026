import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../server/security/secrets';

/** Bora P3-A (task C): the bearer prefix is case-insensitive in HTTP, so redaction must be too. */
describe('redactSecrets bearer prefix', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (const prefix of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
    it(`masks "${prefix} <token>"`, () => {
      const out = redactSecrets(`authorization: ${prefix} ${token}`);
      expect(out).not.toContain(token);
    });
  }
});
