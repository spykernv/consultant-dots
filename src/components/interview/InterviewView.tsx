"use client";

import { useEffect, useRef } from "react";
import { Flag } from "lucide-react";
import { interviewActions } from "@/lib/interview/client";
import { useSession } from "@/lib/store/session-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Composer } from "./Composer";
import { Debrief } from "./Debrief";
import { InterviewSidebar } from "./InterviewSidebar";
import { Panel } from "./Panel";
import { confirmEnd, phaseOf, roundsOf } from "./phase";
import { Preparing } from "./Preparing";
import { SystemNotes, Transcript } from "./Transcript";

function CaseColumn({ className }: { className?: string }) {
  const caseText = useSession((s) => s.caseText);
  return (
    <Panel title="Le case" className={className}>
      <p className="text-xs leading-relaxed whitespace-pre-line text-slate-600">{caseText}</p>
    </Panel>
  );
}

export function InterviewView() {
  const interview = useSession((s) => s.interview);
  const mock = useSession((s) => s.mock);
  const end = useRef<HTMLDivElement>(null);
  const resumed = useRef(false);
  const scrolled = useRef(false);
  const messageCount = interview?.messages.length ?? 0;
  const status = interview?.status;

  // Once per mount (strict mode runs effects twice): a reload can land mid-turn or mid-preparation.
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    interviewActions.resume();
  }, []);

  // Keep the latest message in view; the debrief scrolls itself into view when it appears.
  useEffect(() => {
    const node = end.current;
    if (!node) return;
    if (!scrolled.current) {
      // On mount only the panel's own scroll moves: on a phone the page stays on the case.
      scrolled.current = true;
      const box = node.parentElement;
      if (box && status !== "done") box.scrollTop = box.scrollHeight;
      return;
    }
    if (status !== "done") node.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messageCount, status]);

  if (!interview) return null;
  const { remaining, label, canEnd } = roundsOf(interview);
  const { over, live } = phaseOf(interview);

  return (
    <main className="grid flex-1 grid-cols-1 gap-3 p-3 lg:min-h-0 lg:grid-cols-[minmax(240px,26fr)_minmax(380px,50fr)_minmax(240px,24fr)] lg:grid-rows-[minmax(0,1fr)]">
      <CaseColumn className="max-lg:max-h-[40dvh]" />
      <Panel
        title="Entretien client"
        status={
          <>
            {mock && (
              <Badge variant="outline" className="border-violet-200 bg-violet-50 text-[10px] text-violet-700">
                client rejoué (démo)
              </Badge>
            )}
            {/* Below lg the sidebar sits under the whole conversation: the round and the way out stay in sight here. */}
            {messageCount > 0 && (
              <span className="ml-auto flex items-center gap-1.5 lg:hidden">
                <span className="text-[11px] text-slate-500 tabular-nums">{label}</span>
                {!over && (
                  <Button size="xs" variant="ghost" disabled={!canEnd} onClick={() => confirmEnd(remaining)}>
                    <Flag /> Terminer
                  </Button>
                )}
              </span>
            )}
          </>
        }
        // Bounded on a phone too, so the transcript scrolls inside and the composer stays pinned under it.
        className="max-lg:h-[85dvh]"
        footer={live && <Composer status={interview.status} lastRound={remaining === 1} />}
      >
        {interview.status === "preparing" ? (
          <Preparing />
        ) : (
          <div className="space-y-3">
            <Transcript messages={interview.messages} status={interview.status} error={interview.error} />
            <SystemNotes notes={interview.notes} />
            {interview.status === "done" && <Debrief />}
          </div>
        )}
        <div ref={end} />
      </Panel>
      <InterviewSidebar interview={interview} />
    </main>
  );
}
