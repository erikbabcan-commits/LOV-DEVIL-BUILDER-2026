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
  errors,
  readOnly = false,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  errors: { file: string; message: string }[];
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
          errors.map((error) => {
            const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              location = error.message.match(
                new RegExp(escaped + ":(\\d+):(\\d+)"),
              );
            const line = view.state.doc.line(
              Math.max(
                1,
                Math.min(view.state.doc.lines, Number(location?.[1] ?? 1)),
              ),
            );
            const from = Math.min(
              line.to,
              line.from + Math.max(0, Number(location?.[2] ?? 0)),
            );
            return {
              from,
              to: Math.min(view.state.doc.length, from + 1),
              severity: "error" as const,
              message: error.message,
              source: "Posledný build",
            };
          }),
        { delay: 0 },
      ),
    ];
  }, [path, errors]);
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
