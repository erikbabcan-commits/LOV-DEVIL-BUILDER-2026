import { Component, Suspense, lazy, type ReactNode } from "react";
import type { LintMarker } from "./lintMarkers";

// CodeMirror stays in its own lazily loaded chunk; nothing new is added to it.
const SourceEditor = lazy(() => import("../workspace/SourceEditor"));
const noMarkers: LintMarker[] = [];

class SourceBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Lazy CodeMirror host with an error boundary and the plain textarea fallback. */
export function CodeEditorPane({
  path,
  value,
  onChange,
  markers,
  readOnly,
  fallback,
  onUseSimple,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  markers: LintMarker[];
  readOnly: boolean;
  fallback: ReactNode;
  onUseSimple: () => void;
}) {
  return (
    <SourceBoundary key={path} fallback={fallback}>
      <Suspense
        fallback={
          <div className="cp-loading">
            Načítavam editor…{" "}
            <button onClick={onUseSimple}>Použiť jednoduchý editor</button>
          </div>
        }
      >
        <SourceEditor
          path={path}
          value={value}
          onChange={onChange}
          markers={markers.length ? markers : noMarkers}
          readOnly={readOnly}
        />
      </Suspense>
    </SourceBoundary>
  );
}
