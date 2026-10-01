"use client";

import { useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import type { StageId } from "@/lib/schemas";
import { MAX_STEER_CHARS } from "@/lib/schemas/api";
import { STAGE_LABELS } from "@/lib/domain/labels";
import { isPostGate, isStale, STAGE_DEPS } from "@/lib/store/machine";
import { matrixCarryHint } from "@/lib/store/matrix-carry";
import { actions } from "@/lib/store/orchestrator";
import { useLive, useSession } from "@/lib/store/session-store";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "./hooks";

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(".", ",")} s`;

const PHASE_LABELS = { starting: "démarrage", thinking: "réflexion", writing: "rédaction" } as const;

const QUICK_STEERS = [
  "Plus concis",
  "Plus concret et spécifique au case",
  "Plus senior : gouvernance, adoption, valeur mesurable",
  "Un autre angle",
];

const hasDownstream = (stage: StageId) =>
  (Object.entries(STAGE_DEPS) as [StageId, StageId[]][]).some(([, deps]) => deps.includes(stage));

function RegeneratePopover({ stage }: { stage: StageId }) {
  const [open, setOpen] = useState(false);
  const [steer, setSteer] = useState("");
  const lastSteer = useSession((s) => s.stages[stage].steer);
  const matrixHint = useSession((s) =>
    stage === "options"
      ? matrixCarryHint(s.matrix.initiatives, s.stages.options.data?.initiatives ?? [], steer.trim() !== "")
      : null,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-xs" variant="ghost" className="size-5 text-slate-400" aria-label={`Régénérer ${STAGE_LABELS[stage]}`} title="Régénérer avec une consigne">
          <RefreshCw className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-xs">
        <div className="font-semibold text-slate-900">Régénérer « {STAGE_LABELS[stage]} »</div>
        <Textarea
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          placeholder="Consigne (facultatif) : plus concis, autre pilote, insiste sur la gouvernance…"
          maxLength={MAX_STEER_CHARS}
          rows={2}
          className="text-xs"
          autoFocus
        />
        <div className="flex flex-wrap gap-1">
          {QUICK_STEERS.map((quick) => (
            <button
              key={quick}
              type="button"
              onClick={() => setSteer(quick)}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
            >
              {quick}
            </button>
          ))}
        </div>
        {stage === "questions" && <p className="text-[11px] text-amber-700">Les réponses déjà saisies seront effacées.</p>}
        {matrixHint && <p className="text-[11px] text-amber-700">Priorisation : {matrixHint}</p>}
        {hasDownstream(stage) && (
          <p className="text-[11px] text-slate-500">Les sections suivantes seront signalées « à mettre à jour ».</p>
        )}
        {lastSteer && <p className="text-[11px] text-slate-400">Dernière consigne : « {lastSteer} »</p>}
        <Button
          size="sm"
          className="bg-indigo-700 hover:bg-indigo-800"
          onClick={() => {
            actions.regenerate(stage, steer);
            setOpen(false);
            setSteer("");
          }}
        >
          <RefreshCw /> Régénérer
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function OneStage({ stage, showName }: { stage: StageId; showName: boolean }) {
  const run = useSession((s) => s.stages[stage]);
  const stale = useSession((s) => isStale(s, stage));
  const gatePassed = useSession((s) => s.gatePassed);
  const anyRunning = useSession((s) => Object.values(s.stages).some((r) => r.status === "running"));
  const phase = useLive((l) => l.phase[stage]);
  const startedAt = useLive((l) => l.startedAt[stage]);
  const now = useNow(500, run.status === "running");
  const name = showName ? `${STAGE_LABELS[stage]} · ` : "";
  // Before the gate everything can be redone; after it, the clarification inputs are frozen.
  const canRegenerate = stage !== "challenge" && !anyRunning && (isPostGate(stage) || !gatePassed);

  if (run.status === "running") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600">
        <Loader2 className="size-3 animate-spin" />
        {name}
        {PHASE_LABELS[phase ?? "starting"]}… {startedAt ? seconds(now - startedAt) : ""}
      </span>
    );
  }
  if (run.status === "error" || run.status === "interrupted") {
    const label = run.status === "error" ? "Erreur" : "Interrompu";
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-rose-600">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-help items-center gap-1">
              <AlertTriangle className="size-3" />
              {name}
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{run.error?.message ?? "Étape interrompue."}</TooltipContent>
        </Tooltip>
        <Button size="xs" variant="ghost" className="h-5 px-1.5 text-[11px]" onClick={() => actions.retry(stage)}>
          <RotateCcw className="size-3" /> Relancer
        </Button>
      </span>
    );
  }
  if (run.status === "done") {
    return (
      <span className={`inline-flex items-center gap-0.5 text-[11px] ${stale ? "text-amber-600" : "text-slate-400"}`}>
        <Check className="size-3" />
        <span title={run.steer ? `Régénéré avec : « ${run.steer} »` : undefined}>
          {name}
          {stale ? "obsolète" : run.ms != null ? seconds(run.ms) : "ok"}
          {run.steer ? " · ajusté" : ""}
        </span>
        {canRegenerate && <RegeneratePopover stage={stage} />}
      </span>
    );
  }
  return null;
}

export function StageStatus({ stages }: { stages: StageId[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {stages.map((stage) => (
        <OneStage key={stage} stage={stage} showName={stages.length > 1} />
      ))}
    </span>
  );
}
