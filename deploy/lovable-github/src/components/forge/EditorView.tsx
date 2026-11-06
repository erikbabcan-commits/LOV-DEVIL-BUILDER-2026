import { useEffect, useState } from "react";
import { Search, X, FolderOpen } from "lucide-react";
import { Btn, Tabs, StateBlock, DemoTag } from "./ui";
import { TemplateGallery } from "./TemplateGallery";
import { GitHubConnection } from "./GitHubConnection";
import { useForge } from "@/lib/forge-context";
import { ForgeCode, ForgeHistory, ForgePreview } from "./ForgeCanvas";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ForgeZipExport } from "./ForgeZipExport";
function Sidebar({ onClose }: { onClose?: () => void }) {
  const { state, controller, authenticated } = useForge(),
    [query, setQuery] = useState("");
  useEffect(() => {
    if (authenticated) void controller.listProjects();
  }, [controller, authenticated]);
  const list = state.projects.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="flex h-full w-[280px] flex-col gap-3 bg-sidebar p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Projekty</h2>
        {onClose && (
          <Btn size="icon" variant="ghost" aria-label="Zavrieť panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Btn>
        )}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Hľadať projekty"
          placeholder="Hľadať projekty"
          className="h-9 w-full rounded-lg border border-input bg-card pl-8 pr-3 text-[13px]"
        />
      </div>
      <Btn
        size="sm"
        disabled={!authenticated || state.busy || !!state.pending || !!state.editor}
        onClick={() => void controller.newProject()}
      >
        Nový projekt
      </Btn>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        <h3 className="text-xs text-muted-foreground">Na serveri</h3>
        {!list.length && (
          <p className="text-xs text-muted-foreground">Zatiaľ žiadny zodpovedajúci projekt.</p>
        )}
        {list.map((p) => (
          <button
            key={p.id}
            disabled={state.busy || !!state.pending || !!state.editor}
            onClick={() => {
              void controller.open(p.id);
              onClose?.();
            }}
            aria-current={state.id === p.id ? "true" : undefined}
            className="block w-full truncate rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-accent"
          >
            {p.title} · r{p.revision}
          </button>
        ))}
        <Btn
          size="sm"
          disabled={!authenticated || state.busy}
          onClick={() => void controller.listProjects()}
        >
          Obnoviť projekty
        </Btn>
        {state.cursor && (
          <Btn size="sm" onClick={() => void controller.listProjects(true)}>
            Ďalšie projekty
          </Btn>
        )}
        <h3 className="text-xs text-muted-foreground">V tomto prehliadači</h3>
        {state.localDrafts.map((p) => (
          <button
            key={p.id}
            disabled={state.busy || !!state.pending || !!state.editor}
            onClick={() => {
              void controller.openLocal(p.id);
              onClose?.();
            }}
            className="block w-full truncate rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-accent"
          >
            {p.title}
            {p.dirty ? " · lokálne zmeny" : ""}
          </button>
        ))}
      </div>
      <GitHubConnection />
    </div>
  );
}
export function EditorView({
  drawer,
  setDrawer,
}: {
  drawer: boolean;
  setDrawer: (value: boolean) => void;
}) {
  const { state, controller, authenticated } = useForge(),
    [tab, setTab] = useState("Náhľad");
  return (
    <Sheet open={drawer} onOpenChange={setDrawer}>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden border-r border-border md:block">
          <Sidebar />
        </aside>
        <SheetContent
          side="left"
          aria-describedby={undefined}
          className="w-[280px] p-0 sm:max-w-[280px] [&>button]:hidden"
        >
          <SheetTitle className="sr-only">Projekty</SheetTitle>
          <Sidebar onClose={() => setDrawer(false)} />
        </SheetContent>
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {state.workspace.title}
            </h1>
            <SheetTrigger asChild>
              <Btn size="sm" className="md:hidden">
                <FolderOpen className="h-3.5 w-3.5" /> Projekty
              </Btn>
            </SheetTrigger>
            <Btn
              disabled={!authenticated || state.busy || !!state.pending || !!state.editor}
              onClick={() => void controller.save()}
            >
              Uložiť na server
            </Btn>
            <Btn
              disabled={!authenticated || state.busy || !!state.pending || !!state.editor}
              onClick={() => void controller.save(true)}
            >
              Uložiť kópiu
            </Btn>
            <ForgeZipExport className="md:hidden" />
          </div>
          {state.error && tab !== "Súbory" && (
            <p role="alert" className="px-4 py-2 text-xs text-destructive">
              {state.error}
            </p>
          )}
          {state.notice && (
            <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
              {state.notice}
            </p>
          )}
          <div className="px-4 pt-3">
            <Tabs
              tabs={["Náhľad", "Súbory", "História", "Šablóny", "Prompty"]}
              value={tab}
              onChange={setTab}
              label="Editor"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {tab === "Náhľad" ? (
              <ForgePreview />
            ) : tab === "Súbory" ? (
              <ForgeCode />
            ) : tab === "História" ? (
              <ForgeHistory />
            ) : tab === "Šablóny" ? (
              <>
                <DemoTag />
                <TemplateGallery />
              </>
            ) : (
              <StateBlock
                state="empty"
                title="Popíš zmenu vo Workspace"
                text="Požiadavky smerujú do zvoleného AI modelu; pred použitím ich skontroluješ."
              />
            )}
          </div>
        </section>
      </div>
    </Sheet>
  );
}
