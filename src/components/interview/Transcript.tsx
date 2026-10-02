"use client";

import { useState } from "react";
import { AlertTriangle, ArrowRight, BookOpenCheck, ChevronDown, Info, Loader2, RotateCcw } from "lucide-react";
import { interviewActions } from "@/lib/interview/client";
import type { InterviewAction, InterviewMessage, InterviewStatus, ToolTrace } from "@/lib/interview/schema";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { confirmLeave, phaseOf } from "./phase";

/** Shown only once the interview is over: during it, naming the client's move would break the role play. */
const ACTION_LABELS: Record<InterviewAction, string> = {
  clarify: "a répondu",
  probe: "a demandé des précisions",
  challenge: "a challengé",
  redirect: "a recadré",
  wrap_up: "a conclu",
};

/**
 * What the client checked before replying, as the candidate may see it: the fact sheet's entries and the quotes it
 * verified. The private notes (record_observation) are the debrief's, and a refused call checked nothing.
 */
export function visibleLookups(tools: ToolTrace[] | undefined): string | null {
  const answers: string[] = [];
  const facts: string[] = [];
  let quotes = 0;
  for (const call of tools ?? []) {
    if (!call.ok) continue;
    const ids = call.name === "get_client_answer" ? answers : call.name === "lookup_fact" ? facts : null;
    const id = call.target.trim().toUpperCase();
    if (ids && id && !ids.includes(id)) ids.push(id);
    if (call.name === "check_quote") quotes++;
  }
  const list = (word: string, ids: string[]) =>
    ids.length > 0 ? `${word}${ids.length > 1 ? "s" : ""} ${ids.join(", ")}` : null;
  const sheet = [list("réponse", answers), list("fait", facts)].filter((part) => part !== null);
  const parts = [
    sheet.length > 0 ? `Fiche client : ${sheet.join(" · ")}` : null,
    quotes === 1 ? "citation vérifiée" : quotes > 1 ? `${quotes} citations vérifiées` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function Bubble({ message, showMove }: { message: InterviewMessage; showMove: boolean }) {
  const client = message.role === "interviewer";
  const lookups = client ? visibleLookups(message.tools) : null;
  return (
    <li className={cn("flex flex-col gap-0.5", client ? "items-start" : "items-end")}>
      <span className="px-1 text-[10.5px] font-medium text-slate-400">{client ? "Client" : "Toi"}</span>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-line",
          client ? "rounded-tl-sm bg-slate-100 text-slate-800" : "rounded-tr-sm bg-indigo-700 text-white",
        )}
      >
        {message.text}
      </div>
      {lookups && (
        <span className="flex items-center gap-1 px-1 text-[10.5px] text-slate-500">
          <BookOpenCheck className="size-3 shrink-0" />
          {lookups}
        </span>
      )}
      {showMove && client && message.action && (
        <span className="px-1 text-[10.5px] text-slate-400 italic">Le client {ACTION_LABELS[message.action]}</span>
      )}
    </li>
  );
}

function Typing() {
  return (
    <li className="flex flex-col items-start gap-0.5" aria-label="Le client répond">
      <span className="px-1 text-[10.5px] font-medium text-slate-400">Client</span>
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-slate-100 px-3 py-2 text-xs text-slate-500">
        <span className="flex gap-0.5" aria-hidden>
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-1.5 animate-bounce rounded-full bg-slate-400"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        Le client répond…
      </div>
    </li>
  );
}

/** After a failed debrief the client has already wrapped up: the box must not read as a conversation cut short. */
function failureText(error: string | null, debriefFailed: boolean) {
  if (!debriefFailed) return error ?? "L'entretien s'est interrompu.";
  // The client names the failed step in its own messages; a message saved by an older version may not.
  if (error?.startsWith("Le débrief")) return error;
  return error ? `Le débrief n'a pas pu être généré : ${error}` : "Le débrief n'a pas pu être généré.";
}

export function SystemNotes({ notes }: { notes: string[] }) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600">
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
        Notes du système ({notes.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 space-y-0.5 pl-4">
          {notes.map((note, i) => (
            <li key={i} className="flex gap-1 text-[11px] text-slate-500">
              <Info className="mt-0.5 size-3 shrink-0 text-slate-400" />
              {note}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Transcript({
  messages,
  status,
  error,
}: {
  messages: InterviewMessage[];
  status: InterviewStatus;
  error: string | null;
}) {
  const { over, debriefFailed } = phaseOf({ status, messages, error });
  // Before the opening, the failure is the preparation's: there is no conversation to leave yet.
  const canLeave = messages.some((m) => m.role === "candidate");
  return (
    <div className="space-y-3">
      {/* A replayed transcript is read, not followed: only a running interview announces its new messages. */}
      <ol className="space-y-3" aria-live={status === "done" ? undefined : "polite"}>
        {messages.map((message, i) => (
          <Bubble key={i} message={message} showMove={over} />
        ))}
        {status === "waiting" && <Typing />}
      </ol>
      {status === "error" && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{failureText(error, debriefFailed)}</span>
          <Button size="xs" variant="outline" className="border-rose-200 bg-white" onClick={() => interviewActions.retry()}>
            <RotateCcw /> Réessayer
          </Button>
          {/* Retrying can keep failing (usage limit, timeout): the analysis must stay reachable without clearing the case. */}
          {canLeave && (
            <Button size="xs" variant="ghost" className="text-rose-800 hover:bg-rose-100" onClick={confirmLeave}>
              Passer à l&apos;analyse complète <ArrowRight />
            </Button>
          )}
        </div>
      )}
      {status === "debriefing" && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span>
            <strong className="font-semibold">Débrief en cours…</strong> tes messages sont relus au regard des 10 réflexes
            du consultant (E1–E10).
          </span>
        </div>
      )}
    </div>
  );
}
