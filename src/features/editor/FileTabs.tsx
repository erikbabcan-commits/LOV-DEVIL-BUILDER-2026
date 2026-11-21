import type { KeyboardEvent } from "react";

export type EditorTab = { name: string; saved: string; draft: string };

/** Open-file tabs (WAI-ARIA tabs pattern): ←/→/Home/End move, Delete closes. */
export function FileTabs({
  tabs,
  active,
  idPrefix,
  panelId,
  closeDisabled,
  onSelect,
  onClose,
}: {
  tabs: EditorTab[];
  active: string | null;
  idPrefix: string;
  panelId?: string;
  closeDisabled?: boolean;
  onSelect: (name: string) => void;
  onClose: (name: string) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).getAttribute("role") !== "tab") return;
    const i = tabs.findIndex((t) => t.name === active);
    if (event.key === "Delete" && i >= 0 && !closeDisabled) {
      event.preventDefault();
      onClose(tabs[i].name);
      return;
    }
    const next =
      event.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (i - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next >= 0) {
      event.preventDefault();
      onSelect(tabs[next].name);
      const buttons =
        event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]");
      buttons[next]?.focus();
    }
  }
  return (
    <div
      className="editor-tabs"
      role="tablist"
      aria-label="Otvorené súbory"
      onKeyDown={onKeyDown}
    >
      {tabs.map((item, i) => {
        const dirty = item.draft !== item.saved,
          selected = item.name === active;
        return (
          <div
            key={item.name}
            className={"editor-tab" + (selected ? " active" : "")}
            onAuxClick={(event) => {
              if (event.button === 1 && !closeDisabled) onClose(item.name);
            }}
          >
            <button
              role="tab"
              id={idPrefix + "-" + i}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              title={item.name + (dirty ? " (neuložené zmeny)" : "")}
              onClick={() => onSelect(item.name)}
            >
              {item.name}
              {dirty && (
                <span
                  className="dirty-dot"
                  role="img"
                  aria-label="neuložené zmeny"
                />
              )}
            </button>
            <button
              className="tab-close"
              aria-label={"Zavrieť " + item.name}
              disabled={closeDisabled}
              onClick={() => onClose(item.name)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
