"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown, HelpCircle } from "lucide-react";
import { MAX_NOTES_CHARS } from "@/lib/schemas/api";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { compact, useStageView } from "./hooks";
import { Placeholder } from "./Zone";

function QuestionCards() {
  const { data, streaming } = useStageView("questions");
  const answers = useSession((s) => s.answers);
  const gatePassed = useSession((s) => s.gatePassed);
  const questions = compact(data?.questions);

  return (
    <ol className="space-y-2">
      {questions.map((q, i) => {
        const id = q.id ?? `Q${i + 1}`;
        const answer = answers[id] ?? "";
        return (
          <li key={id} className="rounded-lg border border-slate-200 bg-white p-2.5">
            <div className="flex items-start gap-2">
              <span className="mt-px rounded bg-slate-900 px-1.5 font-mono text-[10px] leading-4 text-white">{id}</span>
              <p className="text-sm font-medium text-slate-900">{q.question}</p>
            </div>
            <dl className="mt-1.5 grid gap-x-3 gap-y-0.5 pl-8 text-[11px] sm:grid-cols-[auto_1fr]">
              {q.whyItMatters && (
                <>
                  <dt className="text-slate-400">Pourquoi</dt>
                  <dd className="text-slate-600">{q.whyItMatters}</dd>
                </>
              )}
              {q.decisionImpact && (
                <>
                  <dt className="text-slate-400">Décision</dt>
                  <dd className="font-medium text-indigo-700">{q.decisionImpact}</dd>
                </>
              )}
            </dl>
            <div className="mt-2 pl-8">
              <Textarea
                value={answer}
                onChange={(e) => actions.setAnswer(id, e.target.value)}
                // The questions can still change while they stream in: an answer typed now could land on another one.
                readOnly={streaming}
                placeholder={
                  streaming ? "Tu pourras répondre une fois les questions prêtes" : "Réponse du client (laisser vide pour garder l'hypothèse)"
                }
                maxLength={2000}
                rows={1}
                className={cn(
                  "min-h-8 resize-y bg-white py-1.5 text-xs",
                  answer.trim() ? "border-sky-300 bg-sky-50/40" : "",
                  streaming && "cursor-not-allowed opacity-60",
                )}
              />
              {q.defaultAssumption && (
                <p className={cn("mt-1 text-[11px]", answer.trim() ? "text-slate-400 line-through" : "text-amber-700")}>
                  Hypothèse par défaut : {q.defaultAssumption}
                </p>
              )}
            </div>
          </li>
        );
      })}
      {!gatePassed && questions.length === 0 && <Placeholder>Les questions arrivent…</Placeholder>}
    </ol>
  );
}

function ClientNotes() {
  const clientNotes = useSession((s) => s.clientNotes);
  return (
    <div className="mt-2">
      <label className="mb-1 block text-[11px] font-medium text-slate-500">Autres informations données par le client</label>
      <Textarea
        value={clientNotes}
        onChange={(e) => actions.setClientNotes(e.target.value)}
        placeholder="Une information par ligne"
        maxLength={MAX_NOTES_CHARS}
        rows={2}
        className="min-h-12 bg-white text-xs"
      />
    </div>
  );
}

function GateButton() {
  const questions = useSession((s) => s.stages.questions.data?.questions ?? []);
  const answers = useSession((s) => s.answers);
  const notes = useSession((s) => s.clientNotes.trim());
  const answered = questions.filter((q) => (answers[q.id] ?? "").trim()).length;
  const assumed = questions.length - answered;
  const none = answered === 0 && !notes;

  return (
    <div className="sticky bottom-0 -mx-3 mt-3 border-t border-slate-100 bg-white/95 px-3 pt-2 pb-1 backdrop-blur">
      <Button className="w-full bg-indigo-700 hover:bg-indigo-800" onClick={() => actions.continueAfterQuestions()}>
        {none ? (
          <>Aucune clarification → continuer avec les hypothèses</>
        ) : (
          <>
            Continuer avec ces clarifications · {answered} réponse{answered > 1 ? "s" : ""}, {assumed} hypothèse
            {assumed > 1 ? "s" : ""}
          </>
        )}
        <ArrowRight />
      </Button>
      <p className="mt-1 text-center text-[11px] text-slate-400">
        Les questions sans réponse deviennent des hypothèses de travail, affichées comme telles.
      </p>
    </div>
  );
}

export function QuestionsBlock() {
  const gatePassed = useSession((s) => s.gatePassed);
  const status = useSession((s) => s.stages.questions.status);
  const [open, setOpen] = useState(false);

  if (!gatePassed) {
    return (
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <HelpCircle className="size-3.5 text-indigo-600" /> Questions à poser en premier
        </h3>
        <QuestionCards />
        {status === "done" && (
          <>
            <ClientNotes />
            <GateButton />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mb-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-700">
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
          Questions & clarifications
          <span className="ml-auto font-normal text-slate-400">modifiables</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <QuestionCards />
          <ClientNotes />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
