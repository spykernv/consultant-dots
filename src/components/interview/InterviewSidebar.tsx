"use client";

import { Flag } from "lucide-react";
import { MAX_CANDIDATE_CHARS, type InterviewState } from "@/lib/interview/schema";
import { useSession } from "@/lib/store/session-store";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "@/components/workspace/Zone";
import { Panel } from "./Panel";
import { confirmEnd, phaseOf, roundsOf } from "./phase";

const howItWorks = (maxRounds: number) => [
  "Mène l'entretien comme en vrai : pose tes questions, reformule, teste tes hypothèses.",
  "Le client ne répond qu'à ce que tu lui demandes et ne te donnera pas la solution.",
  "Il peut te relancer ou te challenger si ta piste n'est pas étayée.",
  `L'entretien s'arrête au ${maxRounds}e tour, ou plus tôt si tu conclus par ta recommandation.`,
  `Chaque message est limité à ${MAX_CANDIDATE_CHARS.toLocaleString("fr-FR")} caractères : c'est voulu, un exercice de synthèse, comme face à un vrai client.`,
  "Le débrief relit tes messages au regard des 10 réflexes du consultant et te donne un score.",
];

export function InterviewSidebar({ interview, className }: { interview: InterviewState; className?: string }) {
  const totalAnswers = useSession((s) => s.stages.questions.data?.questions.length ?? 0);
  const { sent, remaining, label, canEnd } = roundsOf(interview);
  // A failed debrief is over too: the client has said goodbye, only the debrief is left to retry.
  const { over } = phaseOf(interview);

  return (
    <Panel title="Déroulé" className={className}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-slate-900">{label}</span>
        {!over && (
          <span className="text-[11px] text-slate-400">
            {remaining} restant{remaining > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label="Tours utilisés"
        aria-valuemin={0}
        aria-valuemax={interview.maxRounds}
        aria-valuenow={sent}
      >
        <div
          className="h-full rounded-full bg-indigo-600 transition-[width]"
          style={{ width: `${(sent / interview.maxRounds) * 100}%` }}
        />
      </div>
      {totalAnswers > 0 && interview.status !== "preparing" && (
        <p className="mt-2 text-[11px] text-slate-500">
          Réponses clés obtenues : <strong className="text-slate-700">{interview.revealed.length}</strong> / {totalAnswers}
        </p>
      )}

      <SectionTitle>Comment ça marche</SectionTitle>
      <ul className="space-y-1.5">
        {howItWorks(interview.maxRounds).map((line) => (
          <li key={line} className="flex gap-1.5 text-xs text-slate-600">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-indigo-400" />
            {line}
          </li>
        ))}
      </ul>

      {!over && (
        <Button variant="outline" size="sm" className="mt-4 w-full" disabled={!canEnd} onClick={() => confirmEnd(remaining)}>
          <Flag /> Terminer l&apos;entretien
        </Button>
      )}
      {!over && sent === 0 && interview.status === "ready" && (
        <p className="mt-1 text-center text-[11px] text-slate-400">Envoie au moins un message pour pouvoir terminer.</p>
      )}
    </Panel>
  );
}
