import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fuzzyFilter, type FuzzyMatch } from "./fuzzy";

function Highlighted({ match }: { match: FuzzyMatch }) {
  const hit = new Set(match.indices);
  return (
    <>
      {[...match.path].map((char, i) =>
        hit.has(i) ? (
          <mark
            key={i}
            style={{
              background: "transparent",
              color: "var(--accent-text)",
              fontWeight: 700,
            }}
          >
            {char}
          </mark>
        ) : (
          char
        ),
      )}
    </>
  );
}

/** Ctrl/Cmd+P quick open: keyboard-first combobox over project file paths. */
export function FuzzySearch({
  files,
  onOpen,
  onClose,
}: {
  files: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    id = useId();
  const results = useMemo(() => fuzzyFilter(query, files), [query, files]);
  const current = Math.min(selected, Math.max(0, results.length - 1));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    document
      .getElementById(id + "-opt-" + current)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current, id]);
  function choose(index: number) {
    const match = results[index];
    if (!match) return;
    onClose();
    onOpen(match.path);
  }
  return (
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={id + "-title"}
        className="fuzzy-search"
        style={{
          width: "min(560px, 92vw)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius, 12px)",
          boxShadow: "var(--shadow)",
          overflow: "hidden",
          color: "var(--text)",
        }}
      >
        <h2
          id={id + "-title"}
          style={{
            margin: 0,
            padding: "10px 12px 0",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--muted)",
          }}
        >
          Rýchle otvorenie súboru
        </h2>
        <input
          ref={input}
          role="combobox"
          aria-label="Hľadať súbor"
          aria-expanded="true"
          aria-controls={id + "-list"}
          aria-autocomplete="list"
          aria-activedescendant={
            results.length ? id + "-opt-" + current : undefined
          }
          placeholder="Názov súboru…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            const last = results.length - 1;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected(current >= last ? 0 : current + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(current <= 0 ? Math.max(0, last) : current - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(current);
            } else if (event.key === "Tab") {
              event.preventDefault();
            }
          }}
          style={{
            display: "block",
            width: "calc(100% - 24px)",
            margin: "8px 12px",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-elevated)",
            color: "var(--text)",
            fontFamily: "ui-monospace,monospace",
            fontSize: 13,
          }}
        />
        <ul
          id={id + "-list"}
          role="listbox"
          aria-label="Súbory projektu"
          style={{
            listStyle: "none",
            margin: 0,
            padding: "0 0 6px",
            maxHeight: "50vh",
            overflowY: "auto",
          }}
        >
          {results.map((match, i) => (
            <li
              key={match.path}
              id={id + "-opt-" + i}
              role="option"
              aria-selected={i === current}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => i !== current && setSelected(i)}
              onClick={() => choose(i)}
              style={{
                padding: "6px 14px",
                cursor: "pointer",
                fontFamily: "ui-monospace,monospace",
                fontSize: 12.5,
                overflowWrap: "anywhere",
                background: i === current ? "var(--accent-soft)" : undefined,
                boxShadow:
                  i === current ? "inset 2px 0 var(--accent-text)" : undefined,
              }}
            >
              <Highlighted match={match} />
            </li>
          ))}
        </ul>
        <p
          role="status"
          style={{
            margin: 0,
            padding: "6px 12px 10px",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {results.length
            ? results.length + " súborov · ↑↓ výber · Enter otvorí · Esc zavrie"
            : "Žiadny súbor nezodpovedá hľadaniu."}
        </p>
      </div>
    </div>
  );
}
