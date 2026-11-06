import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { Btn } from "./ui";
import { useForge } from "@/lib/forge-context";
import { ForgeCanvas } from "./ForgeCanvas";
import { cn } from "@/lib/utils";
export function WorkspaceView({ idea }: { idea: string }) {
  const { state, controller, authenticated } = useForge(),
    [message, setMessage] = useState(() => (state.workspace.conversation?.length ? "" : idea));
  const model = state.models.models.find((m) => m.id === state.modelId);
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "flex w-full shrink-0 flex-col border-b border-border md:max-h-none md:w-[400px] md:border-b-0 md:border-r",
          state.pending ? "max-h-[24vh]" : "max-h-[45vh]",
        )}
      >
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <h2 className="mr-auto text-[13px] font-semibold">Chat</h2>
          <select
            aria-label="AI model"
            disabled={state.busy || !!state.pending || !!state.editor || !authenticated}
            value={state.modelId}
            onChange={(e) => controller.selectModel(e.target.value)}
            className="max-w-[210px] rounded-lg border border-border bg-card p-1.5 text-xs"
          >
            <option value="">Vyber model</option>
            {state.models.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.model}
              </option>
            ))}
          </select>
          <Btn
            className={state.pending ? "hidden md:inline-flex" : undefined}
            size="sm"
            disabled={state.busy || !authenticated}
            onClick={() => void controller.loadModels()}
          >
            Obnoviť modely
          </Btn>
          {!!model?.fallbackIds.length && (
            <label className="text-xs">
              <input
                type="checkbox"
                checked={!!state.fallbackIds.length}
                disabled={state.busy}
                onChange={(e) => controller.allowFallback(e.target.checked)}
              />{" "}
              Pri výpadku povoliť:{" "}
              {model.fallbackIds
                .map((id) => state.models.models.find((m) => m.id === id)?.label ?? id)
                .join(", ")}
            </label>
          )}
        </div>
        <ol
          className={cn(
            "flex-1 space-y-3 overflow-y-auto px-4 pb-4",
            state.pending ? "min-h-0" : "min-h-16",
          )}
          aria-live="polite"
        >
          {!authenticated && (
            <li className="text-sm text-secondary-foreground">
              Prihlás sa a over pripojenie backendu.{" "}
              <a href="/auth" className="underline">
                Prihlásiť sa
              </a>
            </li>
          )}
          {state.workspace.conversation?.map((m, i) => (
            <li
              key={i}
              className={cn(
                "max-w-[88%] whitespace-pre-wrap break-words rounded-xl border border-border px-3 py-2 text-[13px] leading-relaxed",
                m.role === "user" ? "ml-auto bg-primary-soft" : "bg-card text-secondary-foreground",
              )}
            >
              {m.content}
            </li>
          ))}
        </ol>
        {state.error && (
          <p role="alert" className="mx-3 text-xs text-destructive">
            {state.error}
          </p>
        )}
        {state.notice && !state.pending && (
          <p role="status" className="mx-3 text-xs text-muted-foreground">
            {state.notice}
          </p>
        )}
        {state.editor && (
          <p className="mx-3 text-xs text-muted-foreground">
            Najprv použi alebo zruš úpravy v záložke Kód.
          </p>
        )}
        {state.pending ? (
          <p className="m-3 shrink-0 text-xs text-muted-foreground">
            Skontroluj návrh v záložke Zmeny.
          </p>
        ) : (
          <form
            className="m-3 flex items-end gap-2 rounded-xl border border-border bg-card p-2 focus-within:border-border-strong"
            onSubmit={(e) => {
              e.preventDefault();
              if (message.trim()) {
                void controller.generate(message);
                setMessage("");
              }
            }}
          >
            <label htmlFor="chat" className="sr-only">
              Správa
            </label>
            <textarea
              id="chat"
              rows={1}
              maxLength={4000}
              disabled={state.busy || !!state.pending || !!state.editor || !authenticated}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Popíš úpravu alebo polož otázku…"
              className="min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-[13px] outline-none"
            />
            {state.busy ? (
              <Btn type="button" onClick={() => controller.cancel()}>
                Zastaviť
              </Btn>
            ) : (
              <Btn
                type="submit"
                variant="primary"
                size="icon"
                aria-label="Odoslať"
                disabled={
                  !message.trim() ||
                  !state.ready ||
                  !!state.pending ||
                  !!state.editor ||
                  !authenticated
                }
              >
                <ArrowUp className="h-4 w-4" />
              </Btn>
            )}
          </form>
        )}
      </aside>
      <ForgeCanvas />
    </div>
  );
}
