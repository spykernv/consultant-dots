"use client";

import { AlertTriangle, CheckCircle2, Info, Lightbulb, Mic, Swords } from "lucide-react";
import { CHALLENGE_LEVEL_LABELS, SEVERITY_LABELS } from "@/lib/domain/labels";
import { REFLEXES } from "@/lib/domain/reflexes";
import type { Challenge, ChallengeLevel, Severity } from "@/lib/schemas/challenge";
import type { ReflexId } from "@/lib/schemas/common";
import { MAX_CHALLENGE_CHARS, MIN_CHALLENGE_CHARS } from "@/lib/schemas/api";
import { SAMPLE_CASES } from "@/lib/samples";
import { isStale } from "@/lib/store/machine";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { compact, useStageView, type DeepPartial } from "./hooks";
import { SectionTitle } from "./Zone";

const LEVEL_STYLES: Record<ChallengeLevel, string> = {
  a_retravailler: "bg-rose-100 text-rose-800",
  correct: "bg-amber-100 text-amber-800",
  solide: "bg-sky-100 text-sky-800",
  impressionnant: "bg-emerald-100 text-emerald-800",
};

const SEVERITY_STYLES: Record<Severity, string> = {
  high: "border-l-rose-500",
  medium: "border-l-amber-400",
  low: "border-l-slate-300",
};

function ChallengeResult({ data, notes }: { data: DeepPartial<Challenge>; notes: string[] }) {
  const flags = compact(data.flags);
  return (
    <div className="space-y-3">
      {data.level && (
        <div className="flex items-start gap-2">
          <span className={cn("shrink-0 rounded px-2 py-0.5 text-xs font-semibold", LEVEL_STYLES[data.level as ChallengeLevel])}>
            {CHALLENGE_LEVEL_LABELS[data.level as ChallengeLevel]}
          </span>
          {data.verdict && <p className="text-sm text-slate-800">{data.verdict}</p>}
        </div>
      )}

      {flags.length > 0 && (
        <div>
          <SectionTitle hint="ce que l'interviewer relèverait">Points à corriger</SectionTitle>
          <ul className="space-y-2">
            {flags.map((flag, i) => {
              const reflex = flag.reflex ? REFLEXES[flag.reflex as ReflexId] : null;
              return (
                <li
                  key={i}
                  className={cn(
                    "rounded-lg border border-l-4 border-slate-200 bg-white p-2 text-xs",
                    flag.severity && SEVERITY_STYLES[flag.severity as Severity],
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <AlertTriangle className="size-3.5 text-rose-500" />
                    <span className="font-semibold text-slate-900">
                      {flag.reflex} · {reflex?.titleFr}
                    </span>
                    {flag.severity && (
                      <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                        {SEVERITY_LABELS[flag.severity as Severity]}
                      </span>
                    )}
                  </div>
                  {flag.quote && (
                    <p className="mt-1 border-l-2 border-slate-200 pl-2 text-slate-500 italic">« {flag.quote} »</p>
                  )}
                  {flag.issue && <p className="mt-1 text-slate-700">{flag.issue}</p>}
                  {flag.interviewerQuestion && (
                    <p className="mt-1 flex gap-1 text-indigo-800">
                      <Mic className="mt-0.5 size-3 shrink-0" />« {flag.interviewerQuestion} »
                    </p>
                  )}
                  {flag.fix && (
                    <p className="mt-1 flex gap-1 text-emerald-800">
                      <Lightbulb className="mt-0.5 size-3 shrink-0" />
                      {flag.fix}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-2">
        {compact(data.strengths).length > 0 && (
          <div>
            <SectionTitle>Points forts</SectionTitle>
            <ul className="space-y-1">
              {compact(data.strengths).map((s, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                  <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-600" />
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {compact(data.missing).length > 0 && (
          <div>
            <SectionTitle>Ce qui manque</SectionTitle>
            <ul className="space-y-1">
              {compact(data.missing).map((m, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-400" />
                  {m}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {compact(data.nextVersion).length > 0 && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-2.5">
          <h3 className="mb-1 text-xs font-semibold text-indigo-900">Ta prochaine version</h3>
          <ol className="list-decimal space-y-1 pl-4 text-xs text-slate-800">
            {compact(data.nextVersion).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ol>
        </div>
      )}

      {notes.length > 0 && (
        <p className="flex items-start gap-1 text-[11px] text-slate-400">
          <Info className="mt-0.5 size-3 shrink-0" />
          {notes.join(" ")}
        </p>
      )}
    </div>
  );
}

export function ChallengePanel() {
  const answer = useSession((s) => s.challengeAnswer);
  const caseId = useSession((s) => s.caseId);
  const stale = useSession((s) => isStale(s, "challenge"));
  const { run, data, streaming } = useStageView("challenge");
  const sample = SAMPLE_CASES.find((c) => c.id === caseId)?.flawedAnswer;
  const tooShort = answer.trim().length < MIN_CHALLENGE_CHARS;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Écris ta structure ou ton pitch comme tu le dirais à l&apos;interviewer. Il repère les erreurs de raisonnement (E1–E10),
        cite tes mots et te dit quoi dire à la place. Tu peux le faire avant même de regarder l&apos;analyse.
      </p>
      <Textarea
        value={answer}
        onChange={(e) => actions.setChallengeAnswer(e.target.value)}
        placeholder="Ma réponse : « Je structurerais ma réponse en… »"
        maxLength={MAX_CHALLENGE_CHARS}
        rows={6}
        className="min-h-32 bg-white text-sm leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-2">
        {sample && !answer.trim() && (
          <Button size="xs" variant="link" className="px-0 text-slate-500" onClick={() => actions.setChallengeAnswer(sample)}>
            Essayer avec une réponse type (avec erreurs)
          </Button>
        )}
        <span className="text-[11px] text-slate-400">
          {answer.length.toLocaleString("fr-FR")} / {MAX_CHALLENGE_CHARS.toLocaleString("fr-FR")}
        </span>
        <Button
          size="sm"
          className="ml-auto bg-indigo-700 hover:bg-indigo-800"
          disabled={tooShort || streaming}
          onClick={() => actions.runChallenge()}
        >
          <Swords /> {run.data ? "Challenger à nouveau" : "Challenger ma réponse"}
        </Button>
      </div>
      {tooShort && answer.trim() && (
        <p className="text-[11px] text-slate-400">Encore quelques mots (au moins {MIN_CHALLENGE_CHARS} caractères).</p>
      )}
      {stale && !streaming && <p className="text-[11px] text-amber-700">Ta réponse a changé depuis le dernier challenge.</p>}
      {run.status === "error" && <p className="text-xs text-rose-600">{run.error?.message}</p>}
      {data && <ChallengeResult data={data} notes={streaming ? [] : run.notes} />}
    </div>
  );
}
