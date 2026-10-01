"use client";

import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { DiagramSpec } from "@/lib/schemas/diagram";
import { NODE_KINDS } from "@/lib/schemas/diagram";
import { KIND_STYLES, toMermaid } from "@/lib/diagram/to-mermaid";
import { NODE_KIND_LABELS } from "@/lib/domain/labels";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { compact, useStageView } from "./hooks";
import { MermaidBlock, type Zoom } from "./MermaidBlock";
import { OptionsDecision } from "./OptionsDecision";
import { PriorityChart } from "./PriorityChart";
import { StageStatus } from "./StageStatus";
import { Placeholder, SectionTitle, Zone } from "./Zone";

export function Legend() {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
      {NODE_KINDS.map((kind) => (
        <span key={kind} className="inline-flex items-center gap-1">
          <span
            className="inline-block size-2.5 rounded-sm border"
            style={{ background: KIND_STYLES[kind].fill, borderColor: KIND_STYLES[kind].stroke }}
          />
          {NODE_KIND_LABELS[kind]}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-slate-500" /> hypothèse
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-4 rounded-sm border-2 border-dashed border-amber-500 bg-amber-50" /> reste local
      </span>
    </div>
  );
}

function Diagram({ diagram, streaming, zoom }: { diagram: DiagramSpec | null; streaming: boolean; zoom: Zoom }) {
  const code = useMemo(() => (diagram ? toMermaid(diagram) : null), [diagram]);
  return (
    <MermaidBlock
      code={code}
      zoom={zoom}
      placeholder={streaming ? "Le schéma se dessine…" : "Schéma à venir."}
      legend={<Legend />}
    />
  );
}

function CurrentTab({ zoom }: { zoom: Zoom }) {
  const { run, streaming, data } = useStageView("currentState");
  return (
    <>
      <Diagram diagram={run.data?.diagram ?? null} streaming={streaming} zoom={zoom} />
      {compact(data?.bottlenecks).length > 0 && (
        <>
          <SectionTitle>Goulots d&apos;étranglement</SectionTitle>
          <ul className="space-y-1">
            {compact(data?.bottlenecks).map((b, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-rose-400" />
                {b}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function TargetTab({ zoom }: { zoom: Zoom }) {
  const { run, streaming, data } = useStageView("target");
  return (
    <>
      <Diagram diagram={run.data?.diagram ?? null} streaming={streaming} zoom={zoom} />
      {compact(data?.keyChanges).length > 0 && (
        <>
          <SectionTitle>Avant → après</SectionTitle>
          <ul className="space-y-1">
            {compact(data?.keyChanges).map((c, i) => (
              <li key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 text-xs">
                <span className="text-slate-500">{c.from}</span>
                <ArrowRight className="size-3 text-indigo-500" />
                <span className="font-medium text-slate-800">{c.to}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {compact(data?.principles).length > 0 && (
        <>
          <SectionTitle>Principes de la cible</SectionTitle>
          <ul className="space-y-1">
            {compact(data?.principles).map((p, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                <span className="font-mono text-[10px] text-indigo-500">P{i + 1}</span>
                {p}
              </li>
            ))}
          </ul>
        </>
      )}
      {compact(data?.operatingModel).length > 0 && (
        <>
          <SectionTitle>Modèle opérationnel</SectionTitle>
          <ul className="space-y-1">
            {compact(data?.operatingModel).map((p, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-700">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-indigo-400" />
                {p}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

type Tab = "current" | "options" | "priority" | "target";

export function DiagramsPanel({ className }: { className?: string }) {
  const gatePassed = useSession((s) => s.gatePassed);
  const optionsReady = useSession((s) => s.stages.options.status !== "idle" || s.stages.options.data !== null);
  const targetReady = useSession((s) => s.stages.target.status !== "idle" || s.stages.target.data !== null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [fit, setFit] = useState(true);
  const zoom: Zoom = { fit, toggle: () => setFit((f) => !f) };
  const active: Tab = tab ?? (targetReady ? "target" : "current");

  return (
    <Zone title="Schémas" notesKey="diagrams" status={<StageStatus stages={["currentState", "target"]} />} className={className} muted={!gatePassed}>
      {!gatePassed ? (
        <Placeholder>Les schémas démarrent après les questions de clarification.</Placeholder>
      ) : (
        <Tabs value={active} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="w-full">
            <TabsTrigger value="current">Existant</TabsTrigger>
            <TabsTrigger value="options" className={cn(!optionsReady && "opacity-50")} title="Options × critères et ce qui ferait changer la recommandation">
              Options
            </TabsTrigger>
            <TabsTrigger value="priority" className={cn(!optionsReady && "opacity-50")} title="Matrice valeur × faisabilité">
              Priorisation
            </TabsTrigger>
            <TabsTrigger value="target" className={cn(!targetReady && "opacity-50")}>
              Cible
            </TabsTrigger>
          </TabsList>
          <TabsContent value="current" className="pt-2">
            <CurrentTab zoom={zoom} />
          </TabsContent>
          <TabsContent value="options" className="pt-2">
            <OptionsDecision zoom={zoom} />
          </TabsContent>
          <TabsContent value="priority" className="pt-2">
            <PriorityChart />
          </TabsContent>
          <TabsContent value="target" className="pt-2">
            <TargetTab zoom={zoom} />
          </TabsContent>
        </Tabs>
      )}
    </Zone>
  );
}
