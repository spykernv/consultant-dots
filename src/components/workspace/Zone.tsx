"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, StickyNote } from "lucide-react";
import { MAX_NOTES_CHARS } from "@/lib/schemas/api";
import type { ZoneKey } from "@/lib/store/machine";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ZoneProps = {
  title: string;
  notesKey?: ZoneKey;
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  muted?: boolean;
  children: ReactNode;
};

const ZoneContext = createContext<{ maximized: boolean; setMaximized: (value: boolean) => void }>({
  maximized: false,
  setMaximized: () => undefined,
});

export const useZone = () => useContext(ZoneContext);

function ZoneNotes({ zone }: { zone: ZoneKey }) {
  const note = useSession((s) => s.notes[zone] ?? "");
  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/70 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-amber-900">
        <StickyNote className="size-3" /> Mes notes
        <span className="ml-auto font-normal text-amber-700/70">incluses dans l&apos;export</span>
      </div>
      <Textarea
        value={note}
        onChange={(e) => actions.setNote(zone, e.target.value)}
        placeholder="Tes idées, reformulations, points à dire…"
        maxLength={MAX_NOTES_CHARS}
        rows={3}
        className="min-h-16 bg-white text-xs"
      />
    </div>
  );
}

export function Zone({ title, notesKey, status, actions: headerActions, className, bodyClassName, muted, children }: ZoneProps) {
  const [maximized, setMaximized] = useState(false);
  const hasNote = useSession((s) => Boolean(notesKey && s.notes[notesKey]?.trim()));
  const [notesOpen, setNotesOpen] = useState(hasNote);

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMaximized(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  return (
    <>
      {maximized && <div className="fixed inset-0 z-40 bg-slate-900/30" onClick={() => setMaximized(false)} />}
      <section
        className={cn(
          "flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm",
          maximized && "fixed inset-4 z-50 shadow-2xl",
          className,
        )}
      >
        <header className="flex min-h-10 items-center gap-2 border-b border-slate-100 px-3 py-1.5">
          <h2 className="text-[11px] font-semibold tracking-[0.12em] whitespace-nowrap text-slate-500 uppercase">{title}</h2>
          {status}
          <div className="ml-auto flex items-center gap-1">
            {headerActions}
            {notesKey && (
              <Button
                size="icon-xs"
                variant="ghost"
                className={cn("relative", notesOpen && "bg-amber-100 text-amber-900")}
                aria-label="Mes notes"
                title="Mes notes"
                onClick={() => setNotesOpen((open) => !open)}
              >
                <StickyNote />
                {hasNote && !notesOpen && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-500" />}
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={maximized ? "Réduire" : "Agrandir"}
              title={maximized ? "Réduire (Échap)" : "Agrandir"}
              onClick={() => setMaximized((m) => !m)}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </div>
        </header>
        <div className={cn("min-h-0 flex-1 overflow-auto p-3", bodyClassName)}>
          {notesKey && notesOpen && <ZoneNotes zone={notesKey} />}
          <div className={cn(muted && "opacity-60")}>
            <ZoneContext.Provider value={{ maximized, setMaximized }}>{children}</ZoneContext.Provider>
          </div>
        </div>
      </section>
    </>
  );
}

export function SectionTitle({ children, hint, action }: { children: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-4 mb-1.5 flex items-baseline gap-2 first:mt-0">
      <h3 className="text-xs font-semibold text-slate-800">{children}</h3>
      {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
    </div>
  );
}

export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-12 items-center justify-center rounded-lg border border-dashed border-slate-200 p-3 text-center text-xs text-slate-400">
      {children}
    </div>
  );
}
