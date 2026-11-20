import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";

export default function SourceEditor({
  path,
  value,
  onChange,
  markers,
  readOnly = false,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  /** Pre-parsed build errors for this file (see features/editor/lintMarkers). */
  markers: { line: number; column: number; message: string }[];
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => {
    const lang = /\.[jt]sx?$/.test(path)
      ? javascript({ jsx: /x$/.test(path), typescript: /\.tsx?$/.test(path) })
      : path.endsWith(".css")
        ? css()
        : path.endsWith(".html")
          ? html()
          : path.endsWith(".json")
            ? json()
            : [];
    return [
      lang,
      EditorView.contentAttributes.of({ "aria-label": "Obsah súboru " + path }),
      EditorView.lineWrapping,
      linter(
        (view) =>
          markers.map((marker) => {
            const doc = view.state.doc,
              line = doc.line(Math.max(1, Math.min(doc.lines, marker.line))),
              from = Math.min(line.to, line.from + marker.column);
            return {
              from,
              to: Math.min(doc.length, from + 1),
              severity: "error" as const,
              message: marker.message,
              source: "Posledný build",
            };
          }),
        { delay: 0 },
      ),
    ];
  }, [path, markers]);
  return (
    <CodeMirror
      readOnly={readOnly}
      editable={!readOnly}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="dark"
      height="100%"
      basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true }}
      indentWithTab={false}
      className="cp-source"
    />
  );
}
