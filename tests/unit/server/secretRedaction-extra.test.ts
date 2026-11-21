// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { containsPotentialSecret, redactSecrets } from '../../../server/security/secrets';

// Deliberately fake canaries assembled at runtime, never usable credentials.
const JWT = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlLWNhbmFyeSJ9', 'FAKEsignatureNOTREAL123'].join('.');
const RK = 'rk_' + 'live_' + 'FAKECANARY1234567890abcd';
const WHSEC = 'whsec_' + 'FAKECANARY1234567890abcd';
const BEARER_TOKEN = 'FAKEbearerCANARY.1234567890';

describe('base redaction covers JWT, rk_live, whsec and Bearer (Bora P3)', () => {
  it('redacts each canary out of a log line', () => {
    const line = `auth=${JWT} restricted=${RK} hook=${WHSEC} header="Authorization: Bearer ${BEARER_TOKEN}"`;
    const out = redactSecrets(line);
    for (const canary of [JWT, RK, WHSEC, BEARER_TOKEN]) expect(out).not.toContain(canary);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('Authorization:');
  });
  it('does not turn a public JWT (e.g. an anon key) into a blocking secret', () => {
    expect(containsPotentialSecret(`const anon = "${JWT}";`)).toBe(false);
  });
  it('leaves ordinary text alone', () => {
    expect(redactSecrets('Bearer of good news; eyJ is a prefix')).toBe('Bearer of good news; eyJ is a prefix');
  });
});
