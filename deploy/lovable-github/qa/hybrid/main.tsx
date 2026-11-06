import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ForgeProvider } from "../../src/components/forge/ForgeProvider";
import { ForgeApp } from "../../src/routes/index";
import { setFixtureUser, useSession } from "./session";
import "../../src/styles.css";
function Fixture() {
  const session = useSession();
  return (
    <div className="flex h-dvh flex-col">
      <div
        style={{
          padding: "6px 12px",
          background: "#252a35",
          color: "#d8deea",
          fontSize: 11,
          display: "flex",
          gap: 12,
        }}
      >
        <strong>Lokálny test · podpísaná syntetická identita</strong>
        <button
          onClick={() => void setFixtureUser("alice")}
          aria-pressed={session.session?.user.id === "alice"}
        >
          Alice
        </button>
        <button
          onClick={() => void setFixtureUser("bob")}
          aria-pressed={session.session?.user.id === "bob"}
        >
          Bob
        </button>
        <button onClick={() => void setFixtureUser(null)}>Odhlásiť test</button>
      </div>
      <div className="hybrid-fixture-app min-h-0 flex-1">
        <style>{`.hybrid-fixture-app > .h-dvh { height: 100%; }`}</style>
        <ForgeProvider>
          <ForgeApp />
        </ForgeProvider>
      </div>
    </div>
  );
}
const root = createRootRoute({ component: Outlet }),
  index = createRoute({ getParentRoute: () => root, path: "/", component: Fixture }),
  router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
