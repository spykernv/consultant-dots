"use client";

import { AlertTriangle, Check, CircleDot, Loader2 } from "lucide-react";
import type { StageStatus } from "@/lib/store/machine";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";

/** The fact sheet comes from these three stages: what the client knows, and the answers it can give. */
const PREPARATION = [
  { stage: "classify", label: "Type de problème identifié" },
  { stage: "frame", label: "Faits du client rassemblés" },
  { stage: "questions", label: "Réponses du client préparées" },
] as const;

function StepIcon({ status }: { status: StageStatus }) {
  if (status === "done") return <Check className="size-3.5 text-emerald-600" />;
  if (status === "running") return <Loader2 className="size-3.5 animate-spin text-indigo-600" />;
  if (status === "error" || status === "interrupted") return <AlertTriangle className="size-3.5 text-rose-500" />;
  return <CircleDot className="size-3.5 text-slate-300" />;
}

export function Preparing() {
  const classify = useSession((s) => s.stages.classify.status);
  const frame = useSession((s) => s.stages.frame.status);
  const questions = useSession((s) => s.stages.questions.status);
  const statuses = { classify, frame, questions };

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-10 text-center">
      <Loader2 className="size-6 animate-spin text-indigo-500" />
      <div>
        <p className="text-sm font-medium text-slate-800">Le client prépare l&apos;entretien…</p>
        <p className="mt-1 text-xs text-slate-500">
          En attendant, relis l&apos;énoncé et note ce que tu ne sais pas encore : ce sont tes premières questions.
        </p>
      </div>
      <ol className="w-full space-y-1.5 rounded-lg border border-slate-100 bg-slate-50/60 p-3 text-left">
        {PREPARATION.map(({ stage, label }) => (
          <li
            key={stage}
            className={cn(
              "flex items-center gap-2 text-xs",
              statuses[stage] === "done" ? "text-slate-700" : statuses[stage] === "running" ? "text-indigo-700" : "text-slate-400",
            )}
          >
            <StepIcon status={statuses[stage]} />
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}
