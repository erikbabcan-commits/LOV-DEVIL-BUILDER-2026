import { useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut, User } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/use-session";
import { Btn } from "./ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

export function AccountMenu() {
  const s = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  if (s.status === "loading") return <span className="h-8 w-8" aria-hidden />;
  if (s.status === "signed-out") {
    return (
      <Link
        to="/auth"
        aria-label="Prihlásiť sa"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-secondary-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LogIn aria-hidden="true" className="h-3.5 w-3.5" />{" "}
        <span className="hidden sm:inline">Prihlásiť sa</span>
      </Link>
    );
  }

  async function signOut() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await qc.cancelQueries();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      qc.clear();
      await navigate({ to: "/auth", replace: true });
    } catch {
      toast.error("Odhlásenie sa nepodarilo dokončiť. Skús to znova.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Btn
          size="icon"
          variant="ghost"
          aria-label="Účet"
          aria-busy={pending}
          disabled={pending}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <User aria-hidden="true" className="h-4 w-4" />
        </Btn>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        aria-label="Účet"
        className="w-56 max-w-[calc(100vw-1rem)] rounded-xl border-border bg-popover p-2 shadow-panel"
      >
        <DropdownMenuLabel className="truncate px-2 py-1.5 text-[12px] font-normal text-muted-foreground">
          {s.email}
        </DropdownMenuLabel>
        <DropdownMenuItem
          disabled={pending}
          onSelect={signOut}
          className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
        >
          <LogOut aria-hidden="true" className="h-3.5 w-3.5" /> Odhlásiť sa
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
