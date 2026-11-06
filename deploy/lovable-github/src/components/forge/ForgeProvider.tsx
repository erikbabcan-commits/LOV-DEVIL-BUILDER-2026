import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/hooks/use-session";
import { honoFetch } from "@/lib/hono-client";
import { ForgeController } from "@/lib/forge-controller";
import { ForgeContext } from "@/lib/forge-context";
function SessionWorkspace({ owner, children }: { owner: string; children: ReactNode }) {
  const [controller] = useState(
    () =>
      new ForgeController(owner, (path, init) =>
        honoFetch(path, { ...init, expectedUserId: owner }),
      ),
  );
  useEffect(() => {
    const release = controller.retain();
    if (owner) void controller.start();
    return release;
  }, [controller, owner]);
  return <ForgeContext.Provider value={controller}>{children}</ForgeContext.Provider>;
}
export function ForgeProvider({ children }: { children: ReactNode }) {
  const session = useSession(),
    owner = session.status === "signed-in" ? (session.session?.user.id ?? "") : "";
  return (
    <SessionWorkspace key={owner || "signed-out"} owner={owner}>
      {children}
    </SessionWorkspace>
  );
}
