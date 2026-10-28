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

export function containsPotentialSecret(value: string): boolean {
  return secretPatterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
