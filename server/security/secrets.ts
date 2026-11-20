/* High-confidence credential guard. This is one layer, not a substitute for a vault. */
const secretPatterns = [
  // A missing/mismatched END marker is a truncated key: redact through EOF.
  /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
  /\b(?:mstrl|sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bsb_secret_[A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:MISTRAL_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

/**
 * Redaction-only patterns (Bora P3): masked in logs/errors, but NOT used by
 * containsPotentialSecret — a public JWT (e.g. a Supabase anon key) in a project
 * must not block AI calls or publishing.
 */
const redactOnlyPatterns = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9+/=_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

export function containsPotentialSecret(value: string): boolean {
  return secretPatterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of [...secretPatterns, ...redactOnlyPatterns]) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
