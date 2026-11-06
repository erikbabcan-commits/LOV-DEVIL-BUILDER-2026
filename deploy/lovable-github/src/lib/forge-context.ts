import { createContext, useContext, useSyncExternalStore } from "react";
import type { ForgeController } from "./forge-controller";
export const ForgeContext = createContext<ForgeController | null>(null);
export function useForge() {
  const controller = useContext(ForgeContext);
  if (!controller) throw new Error("Missing ForgeProvider");
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  return { state, controller, authenticated: !!controller.owner };
}
