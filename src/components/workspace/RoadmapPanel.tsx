"use client";

import { Flag, ShieldAlert, Target } from "lucide-react";
import { KPI_TYPE_LABELS } from "@/lib/domain/labels";
import type { RoadmapPhase } from "@/lib/schemas/roadmap";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { compact, useStageView, type DeepPartial } from "./hooks";
import { StageStatus } from "./StageStatus";
import { Placeholder, SectionTitle, Zone } from "./Zone";

const PHASE_ACCENTS = ["border-t-slate-500", "border-t-sky-500", "border-t-emerald-500", "border-t-indigo-600"];

const DETAIL_ROWS: { key: keyof RoadmapPhase; label: string }[] = [
  { key: "actions", label: "Actions" },
  { key: "deliverables", label: "Livrables" },
  { key: "decisions", label: "Décisions" },
  { key: "dependencies", label: "Dépendances" },
  { key: "kpis", label: "KPIs" },
];

function PhaseCard({ phase, index }: { phase: DeepPartial<RoadmapPhase>; index: number }) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-lg border border-t-4 border-slate-200 bg-white p-2", PHASE_ACCENTS[index % 4])}>
      <div className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{phase.timing}</div>
      <div className="text-xs font-semibold text-slate-900">{phase.name}</div>
      {phase.objective && <p className="mt-0.5 text-[11px] text-slate-600">{phase.objective}</p>}
      <Accordion type="single" collapsible className="mt-1">
        <AccordionItem value="details" className="border-none">
          <AccordionTrigger className="py-1 text-[11px] text-indigo-700 hover:no-underline">Détails</AccordionTrigger>
          <AccordionContent className="space-y-1.5 pb-1">
            {DETAIL_ROWS.map(({ key, label }) => {
              const items = compact(phase[key] as (string | undefined)[] | undefined);
              if (items.length === 0) return null;
              return (
                <div key={key}>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase">{label}</div>
                  <ul className="space-y-0.5">
                    {items.map((item, i) => (
                      <li key={i} className="text-[11px] text-slate-700 before:mr-1 before:text-slate-400 before:content-['•']">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

export function RoadmapPanel({ className }: { className?: string }) {
  const gatePassed = useSession((s) => s.gatePassed);
  const { data } = useStageView("roadmap");
  const phases = compact(data?.phases);

  return (
    <Zone title="Roadmap" notesKey="roadmap" status={<StageStatus stages={["roadmap"]} />} className={className} muted={!gatePassed}>
      {!data ? (
        <Placeholder>La roadmap (phases, pilote, KPIs, risques) arrive après les options.</Placeholder>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {phases.map((phase, i) => (
              <PhaseCard key={i} phase={phase} index={i} />
            ))}
          </div>

          <div className="mt-3 grid gap-3 xl:grid-cols-3">
            {data.pilot && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-900">
                  <Flag className="size-3.5" /> Pilote : {data.pilot.initiative}
                </div>
                {data.pilot.scope && <p className="mt-1 font-medium text-slate-800">{data.pilot.scope}</p>}
                {data.pilot.why && <p className="mt-0.5 text-slate-600">{data.pilot.why}</p>}
                {compact(data.pilot.successCriteria).length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {compact(data.pilot.successCriteria).map((c, i) => (
                      <li key={i} className="text-slate-700 before:mr-1 before:content-['✓']">
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
                {compact(data.pilot.reusableFoundations).length > 0 && (
                  <p className="mt-1.5 text-[11px] text-emerald-800">
                    <span className="font-medium">Fondations réutilisables :</span>{" "}
                    {compact(data.pilot.reusableFoundations).join(" · ")}
                  </p>
                )}
              </div>
            )}

            {compact(data.kpis).length > 0 && (
              <div>
                <SectionTitle>
                  <span className="inline-flex items-center gap-1">
                    <Target className="size-3.5 text-indigo-600" /> KPIs
                  </span>
                </SectionTitle>
                <ul className="space-y-1">
                  {compact(data.kpis).map((k, i) => (
                    <li key={i} className="text-xs">
                      <div className="flex items-baseline gap-1.5">
                        {k.type && (
                          <span className="text-[9px] font-semibold text-slate-400 uppercase">
                            {KPI_TYPE_LABELS[k.type as keyof typeof KPI_TYPE_LABELS] ?? k.type}
                          </span>
                        )}
                        <span className="font-medium text-slate-800">{k.name}</span>
                      </div>
                      {(k.baseline || k.target) && (
                        <div className="text-[11px] text-slate-500">
                          {k.baseline} → <span className="font-medium text-indigo-700">{k.target}</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {compact(data.risks).length > 0 && (
              <div>
                <SectionTitle>
                  <span className="inline-flex items-center gap-1">
                    <ShieldAlert className="size-3.5 text-rose-600" /> Risques
                  </span>
                </SectionTitle>
                <ul className="space-y-1.5">
                  {compact(data.risks).map((r, i) => (
                    <li key={i} className="text-xs">
                      <div className="font-medium text-slate-800">{r.risk}</div>
                      {r.impact && <div className="text-[11px] text-slate-500">Impact : {r.impact}</div>}
                      {r.mitigation && <div className="text-[11px] text-emerald-700">Parade : {r.mitigation}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </Zone>
  );
}
