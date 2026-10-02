"use client";

import { useMemo, useState } from "react";
import { ChevronDown, MessagesSquare } from "lucide-react";
import { interviewScore } from "@/lib/interview/score";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ClientNotes, Debrief } from "./Debrief";
import { SystemNotes, Transcript } from "./Transcript";

/**
 * The interview once left for the analysis: read-only, so that the candidate can compare the two. Leaving again
 * would merge the client's answers over the ones edited since, so nothing here leads back to showFullAnalysis.
 */
export function InterviewRecap() {
  const session = useSession();
  const interview = session.interview;
  const score = useMemo(() => interviewScore(session), [session]);
  const [open, setOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const sent = interview?.messages.filter((m) => m.role === "candidate").length ?? 0;
  if (!interview?.closed || sent === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50/40">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <ChevronDown className={cn("size-3.5 shrink-0 text-indigo-500 transition-transform", !open && "-rotate-90")} />
        <MessagesSquare className="size-3.5 shrink-0 text-indigo-600" />
        <span className="text-xs font-semibold text-indigo-950">Ton entretien client</span>
        <span className="ml-auto text-[11px] text-slate-500 tabular-nums">
          {score ? `${score.score} / 100 · ` : ""}
          {sent} tour{sent > 1 ? "s" : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-indigo-100 p-2.5">
          {interview.debrief ? (
            <Debrief readOnly />
          ) : (
            <>
              <div className="text-xs text-slate-500">
                <p>Pas de débrief pour cet entretien.</p>
                {interview.error && <p className="mt-0.5 text-[11px] text-slate-400">{interview.error}</p>}
              </div>
              {/* Recorded live, the client's notes outlast an interview left before its debrief. */}
              <ClientNotes observations={interview.observations ?? []} />
            </>
          )}
          <Collapsible open={transcriptOpen} onOpenChange={setTranscriptOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700">
              <ChevronDown className={cn("size-3 transition-transform", !transcriptOpen && "-rotate-90")} />
              Relire la conversation ({interview.messages.length} messages)
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-3 rounded-lg bg-white p-2.5">
              {/* "done" whatever the interview ended on: the client's moves are shown and no retry is offered. */}
              <Transcript messages={interview.messages} status="done" error={null} />
              <SystemNotes notes={interview.notes} />
            </CollapsibleContent>
          </Collapsible>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
