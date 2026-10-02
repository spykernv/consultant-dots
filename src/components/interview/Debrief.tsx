"use client";

import { useEffect, useId, useMemo, useRef } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleCheck, CircleX, Lightbulb, Mic, NotebookPen } from "lucide-react";
import { CHALLENGE_LEVEL_LABELS, SEVERITY_LABELS } from "@/lib/domain/labels";
import { REFLEXES } from "@/lib/domain/reflexes";
import { interviewActions } from "@/lib/interview/client";
import type { InterviewObservation } from "@/lib/interview/schema";
import { INTERVIEW_SCORE_FORMULA, interviewScore } from "@/lib/interview/score";
import type { Challenge, ChallengeLevel, Severity } from "@/lib/schemas/challenge";
import type { ReflexId } from "@/lib/schemas/common";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "@/components/workspace/Zone";

// Same look as the challenge panel, so the two critiques read the same way.
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

const scoreTone = (score: number) =>
  score >= 80 ? "text-emerald-700" : score >= 60 ? "text-sky-700" : score >= 40 ? "text-amber-700" : "text-rose-700";

function FlagItem({ flag }: { flag: Challenge["flags"][number] }) {
  return (
    <li className={cn("rounded-lg border border-l-4 border-slate-200 bg-white p-2 text-xs", SEVERITY_STYLES[flag.severity])}>
      <div className="flex flex-wrap items-center gap-1.5">
        <AlertTriangle className="size-3.5 text-rose-500" />
        <span className="font-semibold text-slate-900">
          {flag.reflex} · {REFLEXES[flag.reflex]?.titleFr}
        </span>
        <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">{SEVERITY_LABELS[flag.severity]}</span>
      </div>
      {flag.quote && <p className="mt-1 border-l-2 border-slate-200 pl-2 text-slate-500 italic">« {flag.quote} »</p>}
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
}

function ObservationItem({ observation, alsoFlagged }: { observation: InterviewObservation; alsoFlagged: boolean }) {
  const { reflex, severity, quote, note, round } = observation;
  return (
    <li className={cn("rounded-lg border border-l-4 border-slate-200 bg-white p-2 text-xs", SEVERITY_STYLES[severity])}>
      <div className="flex flex-wrap items-center gap-1.5">
        <NotebookPen className="size-3.5 text-indigo-500" />
        <span className="font-semibold text-slate-900">
          {reflex} · {REFLEXES[reflex]?.titleFr}
        </span>
        <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">{SEVERITY_LABELS[severity]}</span>
        <span className="text-[10px] text-slate-500 tabular-nums">tour {round}</span>
        {alsoFlagged && (
          <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-800">aussi relevé par le débrief</span>
        )}
      </div>
      {quote && <p className="mt-1 border-l-2 border-slate-200 pl-2 text-slate-500 italic">« {quote} »</p>}
      {note && <p className="mt-1 text-slate-700">{note}</p>}
    </li>
  );
}

/**
 * What the client noted while the interview ran, hidden from the candidate until it is over. The notes do not count in
 * the score: the debrief reads the whole conversation, the client noted one moment of it.
 */
export function ClientNotes({
  observations,
  flagged = new Set(),
}: {
  observations: InterviewObservation[];
  /** Reflexes the debrief flagged too. */
  flagged?: ReadonlySet<ReflexId>;
}) {
  if (observations.length === 0) return null;
  return (
    <div>
      <SectionTitle hint="relevées en direct, citations vérifiées dans tes messages">
        Notes du client pendant l&apos;entretien
      </SectionTitle>
      <ul className="space-y-2">
        {observations.map((observation, i) => (
          <ObservationItem key={i} observation={observation} alsoFlagged={flagged.has(observation.reflex)} />
        ))}
      </ul>
    </div>
  );
}

function KeyQuestions({ asked, missed }: { asked: string[]; missed: string[] }) {
  const questions = useSession((s) => s.stages.questions.data?.questions);
  // The score lists ids; the question itself is what the candidate should remember for next time.
  const find = (id: string) => questions?.find((q) => q.id === id);
  return (
    <ul className="space-y-1.5">
      {asked.map((id) => (
        <li key={id} className="flex gap-1.5 text-xs text-slate-700">
          <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
          <span>{find(id)?.question ?? id}</span>
        </li>
      ))}
      {missed.map((id) => {
        const question = find(id);
        return (
          <li key={id} className="flex gap-1.5 text-xs text-slate-700">
            <CircleX className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
            <span>
              {question?.question ?? id}
              {question?.whyItMatters && <span className="block text-[11px] text-slate-400">{question.whyItMatters}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** readOnly: the recap shown in the workspace once the interview is left, without the way to the analysis. */
export function Debrief({ readOnly = false }: { readOnly?: boolean }) {
  const session = useSession();
  const score = useMemo(() => interviewScore(session), [session]);
  const debrief = session.interview?.debrief ?? null;
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  // When it lands at the end of the interview, the debrief takes the focus: a screen reader hears it arrive.
  useEffect(() => {
    if (readOnly) return;
    heading.current?.focus({ preventScroll: true });
    card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [readOnly]);

  if (!debrief || !score) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-500">
        <span className="min-w-0 flex-1">Le débrief n&apos;est pas disponible pour cet entretien.</span>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={() => interviewActions.showFullAnalysis()}>
            Voir l&apos;analyse complète <ArrowRight />
          </Button>
        )}
      </div>
    );
  }
  const { level } = score;
  const blocking = debrief.flags.filter((f) => f.severity === "high");
  const others = debrief.flags.filter((f) => f.severity !== "high");
  // Interviews saved before the client took notes have none.
  const observations = session.interview?.observations ?? [];

  return (
    <div
      ref={card}
      role="region"
      aria-labelledby={headingId}
      className="scroll-mt-3 space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/30 p-3"
    >
      <div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 ref={heading} id={headingId} tabIndex={-1} className="text-sm font-semibold text-slate-900 outline-none">
            Débrief de l&apos;entretien
          </h3>
          <span className="ml-auto inline-flex items-baseline gap-1">
            <span className={cn("text-2xl font-semibold tabular-nums", scoreTone(score.score))}>{score.score}</span>
            <span className="text-xs text-slate-400">/ 100</span>
          </span>
        </div>
        {/* Visible text rather than a tooltip, which a touch screen never opens: the score is meant to be checked by hand. */}
        <details className="mt-1 text-[11px] text-slate-500">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-600">Comment ce score est calculé</summary>
          <p className="mt-1 leading-relaxed">{INTERVIEW_SCORE_FORMULA}</p>
        </details>
      </div>

      {session.mock && (
        <p className="rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px] text-violet-800">
          Démo : ce débrief est rejoué depuis un enregistrement fait sur une autre réponse, il ne lit pas tes messages.
          Lance un vrai entretien pour être débriefé sur ce que tu as dit.
        </p>
      )}

      <div className="flex items-start gap-2">
        {level && (
          <span className={cn("shrink-0 rounded px-2 py-0.5 text-xs font-semibold", LEVEL_STYLES[level])}>
            {CHALLENGE_LEVEL_LABELS[level]}
          </span>
        )}
        {debrief.verdict && <p className="text-sm text-slate-800">{debrief.verdict}</p>}
      </div>

      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>
          Points bloquants : <strong className="text-slate-800 tabular-nums">{score.blockingFlags}</strong>
        </span>
        <span>
          Tours utilisés :{" "}
          <strong className="text-slate-800 tabular-nums">
            {score.roundsUsed} / {score.maxRounds}
          </strong>
        </span>
      </p>

      {score.keyQuestions.total > 0 && (
        <div>
          {/* Same label as the sidebar: it counts the answers the client gave, a deflected question stays missed. */}
          <SectionTitle hint="les questions qui débloquaient le case">
            Réponses clés obtenues : {score.keyQuestions.asked.length} / {score.keyQuestions.total}
          </SectionTitle>
          <KeyQuestions asked={score.keyQuestions.asked} missed={score.keyQuestions.missed} />
        </div>
      )}

      {blocking.length > 0 && (
        <div>
          <SectionTitle hint="ce qu'un interviewer ne laisserait pas passer">Points bloquants</SectionTitle>
          <ul className="space-y-2">
            {blocking.map((flag, i) => (
              <FlagItem key={i} flag={flag} />
            ))}
          </ul>
        </div>
      )}
      {others.length > 0 && (
        <div>
          <SectionTitle>{blocking.length > 0 ? "Autres points à corriger" : "Points à corriger"}</SectionTitle>
          <ul className="space-y-2">
            {others.map((flag, i) => (
              <FlagItem key={i} flag={flag} />
            ))}
          </ul>
        </div>
      )}
      <ClientNotes observations={observations} flagged={new Set(debrief.flags.map((f) => f.reflex))} />

      {debrief.strengths.length > 0 && (
        <div>
          <SectionTitle>Points forts</SectionTitle>
          <ul className="space-y-1">
            {debrief.strengths.map((s, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-600" />
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {debrief.nextVersion.length > 0 && (
        <div className="rounded-lg border border-indigo-200 bg-white p-2.5">
          <h4 className="mb-1 text-xs font-semibold text-indigo-900">Pour ton prochain entretien</h4>
          <ol className="list-decimal space-y-1 pl-4 text-xs text-slate-800">
            {debrief.nextVersion.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ol>
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2 border-t border-indigo-100 pt-3">
          <p className="min-w-48 flex-1 text-[11px] text-slate-500">
            Compare ensuite avec l&apos;analyse structurée du copilote (diagnostic, options, cible, roadmap, oral), construite
            sur ce que le client t&apos;a dit. Ce débrief et la conversation restent consultables dans la zone Raisonnement.
          </p>
          <Button size="sm" className="bg-indigo-700 hover:bg-indigo-800" onClick={() => interviewActions.showFullAnalysis()}>
            Voir l&apos;analyse complète <ArrowRight />
          </Button>
        </div>
      )}
    </div>
  );
}
