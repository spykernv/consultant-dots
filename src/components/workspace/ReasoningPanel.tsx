"use client";

import { AlertTriangle, CheckCircle2, Minus, Plus, Sparkles, Star } from "lucide-react";
import { BACKBONE_STAGES, type BackboneStage, type ReflexId } from "@/lib/schemas/common";
import { BACKBONE_LABELS } from "@/lib/domain/labels";
import { REFLEXES } from "@/lib/domain/reflexes";
import { cn } from "@/lib/utils";
import { compact, useStageView } from "./hooks";
import { PrioritizationMatrix } from "./PrioritizationMatrix";
import { BasisChips } from "./SourceChip";
import { Placeholder, SectionTitle } from "./Zone";

const BACKBONE_COLORS: Record<BackboneStage, string> = {
  cadrage: "bg-slate-500",
  diagnostic: "bg-sky-500",
  options: "bg-violet-500",
  cible: "bg-indigo-600",
  pilote: "bg-emerald-500",
  scale: "bg-teal-600",
};

function ReasoningTree() {
  const { data } = useStageView("diagnose");
  const steps = compact(data?.framework);
  if (steps.length === 0) return null;
  return (
    <>
      <SectionTitle hint="squelette adapté au case">Arbre de raisonnement</SectionTitle>
      <ol className="relative space-y-2 border-l border-slate-200 pl-4">
        {steps.map((step, i) => {
          const backbone = BACKBONE_STAGES.includes(step.backbone as BackboneStage) ? (step.backbone as BackboneStage) : null;
          return (
            <li key={i} className="relative">
              <span
                className={cn(
                  "absolute top-1 -left-[21px] size-2.5 rounded-full ring-2 ring-white",
                  backbone ? BACKBONE_COLORS[backbone] : "bg-slate-300",
                )}
              />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-semibold text-slate-900">
                  {i + 1}. {step.step}
                </span>
                {backbone && <span className="text-[10px] text-slate-400 uppercase">{BACKBONE_LABELS[backbone]}</span>}
              </div>
              {step.focus && <p className="text-xs text-slate-600">{step.focus}</p>}
              {compact(step.keyQuestions).length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {compact(step.keyQuestions).map((q, j) => (
                    <li key={j} className="text-[11px] text-slate-500 before:mr-1 before:content-['?']">
                      {q}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Diagnostic() {
  const { data } = useStageView("diagnose");
  if (!data) return null;
  const findings = compact(data.findings);
  return (
    <>
      {findings.length > 0 && (
        <>
          <SectionTitle>Diagnostic</SectionTitle>
          <ul className="space-y-1.5">
            {findings.map((f, i) => (
              <li key={i} className="text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-slate-800">{f.dimension}</span>
                  {f.basis && <BasisChips basis={f.basis} />}
                </div>
                <p className="text-slate-600">{f.finding}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      {compact(data.rootCauses).length > 0 && (
        <>
          <SectionTitle>Causes racines</SectionTitle>
          <ul className="space-y-1">
            {compact(data.rootCauses).map((c, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                <span className="font-mono text-[10px] text-slate-400">{i + 1}</span>
                {c}
              </li>
            ))}
          </ul>
        </>
      )}
      {data.keyInsight && (
        <div className="mt-3 flex gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2.5 text-sm text-indigo-950">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-indigo-600" />
          <span className="font-medium">{data.keyInsight}</span>
        </div>
      )}
    </>
  );
}

function Options() {
  const { data } = useStageView("options");
  const options = compact(data?.options);
  if (!data || options.length === 0) return null;
  const recommended = data.recommendation?.optionId;
  return (
    <>
      <SectionTitle hint="avant de choisir">Options</SectionTitle>
      <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
        {options.map((o, i) => {
          const isReco = recommended && o.id === recommended;
          return (
            <div
              key={o.id ?? i}
              className={cn(
                "rounded-lg border p-2.5 text-xs",
                isReco ? "border-indigo-300 bg-indigo-50/40 ring-1 ring-indigo-200" : "border-slate-200",
              )}
            >
              <div className="flex items-start gap-1.5">
                <span className="font-semibold text-slate-900">{o.name}</span>
                {isReco && (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded bg-indigo-700 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    <Star className="size-2.5" /> Reco
                  </span>
                )}
              </div>
              {o.description && <p className="mt-0.5 text-slate-500">{o.description}</p>}
              <ul className="mt-1.5 space-y-0.5">
                {compact(o.advantages).map((a, j) => (
                  <li key={`a${j}`} className="flex gap-1 text-slate-700">
                    <Plus className="mt-0.5 size-3 shrink-0 text-emerald-600" />
                    {a}
                  </li>
                ))}
                {compact(o.drawbacks).map((d, j) => (
                  <li key={`d${j}`} className="flex gap-1 text-slate-700">
                    <Minus className="mt-0.5 size-3 shrink-0 text-rose-600" />
                    {d}
                  </li>
                ))}
              </ul>
              {compact(o.conditions).length > 0 && (
                <p className="mt-1.5 text-[11px] text-slate-500">
                  <span className="font-medium">Si :</span> {compact(o.conditions).join(" · ")}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {data.recommendation?.statement && (
        <div className="mt-2 rounded-lg border border-indigo-200 bg-white p-2.5 text-xs">
          <p className="flex gap-1.5 text-sm font-semibold text-indigo-950">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-indigo-600" />
            {data.recommendation.statement}
          </p>
          {data.recommendation.rationale && <p className="mt-1 pl-5.5 text-slate-600">{data.recommendation.rationale}</p>}
          {compact(data.recommendation.dependsOn).length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-5.5 text-[11px] text-amber-800">
              Dépend de : <BasisChips basis={compact(data.recommendation.dependsOn)} showSource={false} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Traps() {
  const { data } = useStageView("options");
  const traps = compact(data?.traps);
  if (traps.length === 0) return null;
  return (
    <>
      <SectionTitle hint="ce que l'interviewer va tester">Pièges à éviter</SectionTitle>
      <ul className="space-y-1.5">
        {traps.map((t, i) => {
          const reflex = t.reflex ? REFLEXES[t.reflex as ReflexId] : null;
          return (
            <li key={i} className="flex gap-2 rounded-lg border border-rose-100 bg-rose-50/60 p-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
              <div>
                <div className="font-semibold text-rose-900">
                  {t.reflex} · {reflex?.titleFr}
                </div>
                {reflex && <div className="text-rose-800 italic">« {reflex.flagFr} »</div>}
                {t.whyHere && <div className="mt-0.5 text-slate-700">{t.whyHere}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ReasoningBlock() {
  const { run: diagnose } = useStageView("diagnose");
  const hasDiagnose = diagnose.data !== null || diagnose.status === "running";
  return (
    <div>
      {!hasDiagnose && <Placeholder>Le diagnostic démarre dès que les clarifications sont validées.</Placeholder>}
      <ReasoningTree />
      <Diagnostic />
      <Options />
      <PrioritizationMatrix />
      <Traps />
    </div>
  );
}
