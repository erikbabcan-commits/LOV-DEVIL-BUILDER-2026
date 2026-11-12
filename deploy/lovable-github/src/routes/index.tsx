import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TopBar, type View } from "@/components/forge/TopBar";
import { HomeView } from "@/components/forge/HomeView";
import { WorkspaceView } from "@/components/forge/WorkspaceView";
import { EditorView } from "@/components/forge/EditorView";
import { ForgeProvider } from "@/components/forge/ForgeProvider";
import { useForge } from "@/lib/forge-context";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VORKEI – AI editor" },
      {
        name: "description",
        content: "AI editor s kontrolou zmien, históriou a vlastnými projektmi.",
      },
      { property: "og:title", content: "VORKEI – AI editor" },
      {
        property: "og:description",
        content: "Navrhni aplikáciu, skontroluj zmeny a pokračuj medzi uloženými verziami.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ForgeProvider>
      <ForgeApp />
    </ForgeProvider>
  );
}
export function ForgeApp() {
  const { state, controller } = useForge();
  const [view, setView] = useState<View>("Domov");
  const [idea, setIdea] = useState("");
  const [drawer, setDrawer] = useState(false);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        view={view}
        setView={setView}
        name={state.workspace.title}
        setName={(title) => controller.rename(title)}
        onMenu={() => {
          setView("Editor");
          setDrawer(true);
        }}
      />
      {view === "Domov" && (
        <HomeView
          onSubmit={(i) => {
            setIdea(i);
            setView("Workspace");
            void controller.generate(i);
          }}
        />
      )}
      {view === "Workspace" && <WorkspaceView idea={idea} />}
      {view === "Editor" && <EditorView drawer={drawer} setDrawer={setDrawer} />}
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
