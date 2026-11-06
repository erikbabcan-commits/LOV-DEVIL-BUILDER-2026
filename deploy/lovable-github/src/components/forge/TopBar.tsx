import { useState } from "react";
import { Check, Hammer, Pencil, Settings, Menu } from "lucide-react";
import { Btn } from "./ui";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./AccountMenu";
import { ConnectionPanel } from "./ConnectionPanel";
import { useForge } from "@/lib/forge-context";
import { ForgeZipExport } from "./ForgeZipExport";
import { ForgePublish } from "./ForgePublish";

export type View = "Domov" | "Workspace" | "Editor";
const VIEWS: View[] = ["Domov", "Workspace", "Editor"];

export function TopBar({
  view,
  setView,
  name,
  setName,
  onMenu,
}: {
  view: View;
  setView: (v: View) => void;
  name: string;
  setName: (n: string) => void;
  onMenu: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [conn, setConn] = useState(false);
  const { state, controller, authenticated } = useForge();

  return (
    <header className="relative flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-background px-2 sm:px-3">
      <Btn
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Otvoriť projekty"
        onClick={onMenu}
      >
        <Menu className="h-4 w-4" />
      </Btn>
      <button
        onClick={() => setView("Domov")}
        className="flex items-center gap-1.5 rounded-lg px-1"
        aria-label="Forge – domov"
      >
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Hammer className="h-4 w-4" />
        </span>
        <span className="hidden font-semibold sm:inline">Forge</span>
      </button>
      <span className="hidden h-5 w-px bg-border sm:block" />
      <div className="flex min-w-0 items-center gap-1">
        {editing ? (
          <input
            autoFocus
            defaultValue={name}
            aria-label="Názov projektu"
            onBlur={(e) => {
              setName(e.target.value.trim() || name);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-8 w-36 rounded-md border border-input bg-card px-2 text-[13px] outline-none focus:border-ring"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="group flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium hover:bg-accent"
            title="Premenovať"
          >
            <span className="truncate max-w-[72px] sm:max-w-[180px]">{name}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        )}
        <span className="hidden items-center gap-1 text-[12px] text-muted-foreground lg:flex">
          <Check className="h-3 w-3 text-success" />{" "}
          {state.editor
            ? "Rozpracované úpravy kódu"
            : state.dirty
              ? "Lokálna pracovná verzia"
              : state.revision
                ? "Uložené na serveri"
                : "Nový projekt"}
        </span>
      </div>

      <nav aria-label="Zobrazenie" className="mx-auto flex rounded-lg bg-muted p-0.5">
        {VIEWS.map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-current={view === v ? "page" : undefined}
            className={cn(
              "h-7 rounded-md px-2 text-[12px] font-medium sm:px-3 sm:text-[13px]",
              view === v
                ? "bg-popover text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v}
          </button>
        ))}
      </nav>

      <div className="flex items-center gap-1">
        <select
          aria-label="Režim generovania"
          value={state.modelId}
          disabled={state.busy || !authenticated}
          onChange={(e) => controller.selectModel(e.target.value)}
          className="hidden h-8 rounded-lg border border-border bg-card px-2 text-[13px] text-secondary-foreground lg:block"
        >
          <option value="">Vyber model</option>
          {state.models.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <ForgeZipExport className="hidden md:inline-flex" />
        <ForgePublish key={controller.owner + ":" + state.id} />
        <Btn
          size="icon"
          variant="ghost"
          aria-label="Pripojenie backendov"
          aria-expanded={conn}
          onClick={() => setConn((c) => !c)}
        >
          <Settings className="h-4 w-4" />
        </Btn>
        <AccountMenu />
      </div>
      {conn && <ConnectionPanel onClose={() => setConn(false)} />}
    </header>
  );
}
