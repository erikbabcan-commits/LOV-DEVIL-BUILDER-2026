/** Build/sandbox error in the existing build-repair format (`state.sandboxErrors`). */
export type BuildError = { file: string; message: string };
/** 1-based line, 0-based column (esbuild convention) for one lint marker. */
export type LintMarker = { line: number; column: number; message: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Maps build errors that belong to `path` onto editor lint markers. A location
 * `path:line:col` anywhere in the message wins; otherwise the marker sits on
 * line 1 (same fallback as before). Errors for other files are ignored.
 */
export function markersFor(path: string, errors: BuildError[]): LintMarker[] {
  const located = new RegExp(
    "(?:^|[^\\w.-])" + escape(path) + ":(\\d+)(?::(\\d+))?",
  );
  const seen = new Set<string>();
  const markers: LintMarker[] = [];
  for (const error of errors) {
    const location = error.message.match(located);
    if (!location && error.file !== path) continue;
    const marker = {
      line: Math.max(1, Number(location?.[1] ?? 1) || 1),
      column: Math.max(0, Number(location?.[2] ?? 0) || 0),
      message: error.message,
    };
    const id = marker.line + ":" + marker.column + ":" + marker.message;
    if (seen.has(id)) continue;
    seen.add(id);
    markers.push(marker);
  }
  return markers;
}
