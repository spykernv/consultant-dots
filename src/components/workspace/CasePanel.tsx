"use client";

import { useState } from "react";
import { ChevronDown, Info, Lightbulb } from "lucide-react";
import { domainLabel } from "@/lib/domain/domains";
import { CONSTRAINT_LABELS } from "@/lib/domain/labels";
import { useSession } from "@/lib/store/session-store";
import type { Domain } from "@/lib/schemas/common";
import type { ConstraintType } from "@/lib/schemas/frame";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { compact, useBrief, useStageView } from "./hooks";
import { IdChip, SourceChip } from "./SourceChip";
import { StageStatus } from "./StageStatus";
import { Placeholder, SectionTitle, Zone } from "./Zone";

function OriginalCase() {
  const caseText = useSession((s) => s.caseText);
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs font-semibold text-slate-800">
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        Énoncé original
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1.5 max-h-56 overflow-auto rounded-md bg-slate-50 p-2 text-xs leading-relaxed whitespace-pre-line text-slate-600">
          {caseText}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Classification() {
  const { data } = useStageView("classify");
  if (!data) return null;
  return (
    <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-indigo-900">{domainLabel(data.primaryDomain as Domain)}</span>
        {typeof data.confidence === "number" && (
          <span className="text-xs text-indigo-600">{Math.round(data.confidence)} %</span>
        )}
      </div>
      {compact(data.secondaryDomains).length > 0 && (
        <div className="text-[11px] text-indigo-700/80">
          Secondaire : {compact(data.secondaryDomains).map((d) => domainLabel(d as Domain)).join(", ")}
        </div>
      )}
      {data.rationale && <p className="mt-1 text-xs text-slate-600">{data.rationale}</p>}
    </div>
  );
}

function Mapping() {
  const { data, run } = useStageView("frame");
  if (!data) return null;
  const facts = compact(data.facts);
  const assumptions = compact(data.assumptions);

  return (
    <>
      {data.reformulation && (
        <>
          <SectionTitle>Le problème en une phrase</SectionTitle>
          <p className="text-sm font-medium text-slate-800">{data.reformulation}</p>
        </>
      )}
      {data.premiseChallenge && (
        <div className="mt-2 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <strong>Recadrage : </strong>
            {data.premiseChallenge}
          </span>
        </div>
      )}

      {compact(data.businessObjectives).length > 0 && (
        <>
          <SectionTitle>Objectifs business</SectionTitle>
          <ul className="space-y-1">
            {compact(data.businessObjectives).map((o, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                {o.source && <SourceChip source={o.source} className="mt-px" />}
                <span>{o.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {compact(data.painPoints).length > 0 && (
        <>
          <SectionTitle>Pain points</SectionTitle>
          <ul className="space-y-1">
            {compact(data.painPoints).map((p, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-rose-400" />
                {p}
              </li>
            ))}
          </ul>
        </>
      )}

      {compact(data.constraints).length > 0 && (
        <>
          <SectionTitle>Contraintes</SectionTitle>
          <ul className="space-y-1">
            {compact(data.constraints).map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                {c.source && <SourceChip source={c.source} className="mt-px" />}
                <span>
                  {c.type && (
                    <span className="mr-1 text-[10px] font-semibold text-amber-700 uppercase">
                      {CONSTRAINT_LABELS[c.type as ConstraintType] ?? c.type}
                    </span>
                  )}
                  {c.text}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {compact(data.stakeholders).length > 0 && (
        <>
          <SectionTitle>Parties prenantes</SectionTitle>
          <ul className="space-y-1">
            {compact(data.stakeholders).map((s, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                {s.source && <SourceChip source={s.source} className="mt-px" />}
                <span>
                  <strong className="font-medium text-slate-900">{s.name}</strong>
                  {s.role && <span className="text-slate-500"> — {s.role}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {(facts.length > 0 || assumptions.length > 0) && (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          <div>
            <h3 className="mb-1.5 text-xs font-semibold text-slate-800">Faits (énoncé)</h3>
            <ul className="space-y-1">
              {facts.map((f, i) => (
                <li key={f.id ?? i} className="flex items-start gap-1.5 text-xs text-slate-700">
                  {f.id && <IdChip id={f.id} source="case" text={f.evidence ? `« ${f.evidence} »` : null} />}
                  <span>{f.text}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1.5 text-xs font-semibold text-slate-800">Hypothèses</h3>
            <ul className="space-y-1">
              {assumptions.map((a, i) => (
                <li key={a.id ?? i} className="flex items-start gap-1.5 text-xs text-slate-700">
                  {a.id && <IdChip id={a.id} source="assumption" text={a.basis ? `Base : ${a.basis}` : null} />}
                  <span>{a.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {run.notes.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="mt-2 inline-flex cursor-help items-center gap-1 text-[11px] text-amber-700">
              <Info className="size-3" />
              {run.notes.length} fait(s) requalifié(s) en hypothèse
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-xs">{run.notes.join("\n")}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function RetainedClarifications() {
  const gatePassed = useSession((s) => s.gatePassed);
  const brief = useBrief();
  if (!gatePassed || !brief) return null;
  return (
    <>
      <SectionTitle hint="utilisées par l'analyse">Clarifications retenues</SectionTitle>
      <ul className="space-y-1.5">
        {brief.clarifications.map((c) => (
          <li key={c.id} className="text-xs">
            <div className="flex items-start gap-1.5 text-slate-500">
              <IdChip id={c.id} source={c.source} text={c.question} />
              <span className="line-clamp-2">{c.question}</span>
            </div>
            <div className="mt-0.5 ml-7 flex items-start gap-1.5 text-slate-800">
              <SourceChip source={c.source} className="mt-px" />
              <span>{c.answer}</span>
            </div>
          </li>
        ))}
        {brief.clientNotes.map((n) => (
          <li key={n.id} className="flex items-start gap-1.5 text-xs text-slate-800">
            <IdChip id={n.id} source="client" text={null} />
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function CasePanel({ className }: { className?: string }) {
  const hasAny = useSession((s) => s.stages.classify.data !== null || s.stages.classify.status === "running");
  return (
    <Zone title="Le case" notesKey="case" status={<StageStatus stages={["classify", "frame"]} />} className={className}>
      <OriginalCase />
      {!hasAny && <Placeholder>Analyse en attente…</Placeholder>}
      <Classification />
      <Mapping />
      <RetainedClarifications />
    </Zone>
  );
}
