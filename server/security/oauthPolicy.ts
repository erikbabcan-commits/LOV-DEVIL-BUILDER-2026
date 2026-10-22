export function allowedOrigins(raw = process.env.GITHUB_ALLOWED_ORIGINS ?? "", production = process.env.NODE_ENV === "production"): Set<string> {
  const origins = raw ? raw.split(",").map(v => v.trim()) : production ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"];
  const result = new Set<string>();
  for (const value of origins) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password ||
        (production ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol))) throw new Error("Invalid OAuth origin allowlist");
    result.add(url.origin);
  }
  return result;
}
export function validCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return allowedOrigins().has(url.origin) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/api/github/auth/callback";
  } catch { return false; }
}
