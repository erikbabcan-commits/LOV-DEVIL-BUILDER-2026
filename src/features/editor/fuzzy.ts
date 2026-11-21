export type FuzzyMatch = { path: string; score: number; indices: number[] };

const isBoundary = (text: string, i: number) =>
  i === 0 ||
  "/._- ".includes(text[i - 1]) ||
  (text[i] >= "A" &&
    text[i] <= "Z" &&
    text[i - 1] >= "a" &&
    text[i - 1] <= "z");

function scan(query: string, path: string, from: number): FuzzyMatch | null {
  const lower = path.toLowerCase();
  const indices: number[] = [];
  let at = from;
  for (const char of query) {
    const found = lower.indexOf(char, at);
    if (found < 0) return null;
    indices.push(found);
    at = found + 1;
  }
  const baseStart = path.lastIndexOf("/") + 1;
  let score = 0;
  indices.forEach((index, n) => {
    score += 1;
    if (n > 0 && indices[n - 1] === index - 1) score += 5;
    if (isBoundary(path, index)) score += 8;
    if (index >= baseStart) score += 3;
  });
  score -=
    (indices[indices.length - 1] - indices[0]) * 0.1 + path.length * 0.01;
  return { path, score, indices };
}

/** Subsequence fuzzy match (case-insensitive), preferring file-name hits. */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return { path, score: 0, indices: [] };
  const whole = scan(q, path, 0);
  const base = scan(q, path, path.lastIndexOf("/") + 1);
  if (!whole || !base) return whole ?? base;
  return base.score >= whole.score ? base : whole;
}

/** Ranked matches; empty query keeps the original project order. */
export function fuzzyFilter(
  query: string,
  paths: string[],
  limit = 50,
): FuzzyMatch[] {
  const matches = paths
    .map((path) => fuzzyMatch(query, path))
    .filter((m): m is FuzzyMatch => m !== null);
  if (query.trim())
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    );
  return matches.slice(0, limit);
}
