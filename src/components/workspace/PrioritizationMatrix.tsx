"use client";

import { useState } from "react";
import { ArrowDownWideNarrow, RotateCcw, X } from "lucide-react";
import { CRITERION_LABELS, VERDICT_LABELS } from "@/lib/domain/labels";
import { CRITERIA, formulaLabel, MAX_WEIGHT, weightedScore, type Criterion } from "@/lib/domain/scoring";
import type { Initiative, Verdict } from "@/lib/schemas/options";
import { matrixEdited } from "@/lib/store/machine";
import { matrixNotices } from "@/lib/store/matrix-carry";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { compact, useStageView, type DeepPartial } from "./hooks";
import { SectionTitle } from "./Zone";

const SCORE_TONES = ["", "bg-slate-50", "bg-slate-100", "bg-indigo-100", "bg-indigo-200", "bg-indigo-300"];
const RISK_TONES = ["", "bg-emerald-50", "bg-emerald-100", "bg-amber-100", "bg-rose-100", "bg-rose-200"];
const VERDICT_STYLES: Record<Verdict, string> = {
  pilot: "bg-emerald-600 text-white",
  next: "bg-indigo-100 text-indigo-800",
  later: "bg-slate-100 text-slate-600",
  avoid: "bg-rose-100 text-rose-700",
};

export const isCompleteInitiative = (i: DeepPartial<Initiative>): i is Initiative =>
  CRITERIA.every((c) => typeof i[c] === "number") && typeof i.name === "string";

function ScoreCell({
  value,
  risk,
  onChange,
}: {
  value: number | undefined;
  risk: boolean;
  onChange?: (direction: 1 | -1) => void;
}) {
  if (typeof value !== "number") return <td className="px-1 py-1" />;
  const tone = (risk ? RISK_TONES : SCORE_TONES)[value] ?? "";
  const face = <span className={cn("inline-block w-6 rounded font-mono text-[11px] tabular-nums", tone)}>{value}</span>;
  return (
    <td className="px-1 py-1 text-center">
      {onChange ? (
        <button
          type="button"
          className="rounded hover:ring-2 hover:ring-indigo-300"
          title="Clic : +1 · Maj+clic ou clic droit : −1"
          onClick={(e) => onChange(e.shiftKey ? -1 : 1)}
          onContextMenu={(e) => {
            e.preventDefault();
            onChange(-1);
          }}
        >
          {face}
        </button>
      ) : (
        face
      )}
    </td>
  );
}

function AddInitiative() {
  const [name, setName] = useState("");
  return (
    <form
      className="mt-1.5 flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        actions.matrix.add(name);
        setName("");
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="+ Ajouter une initiative"
        maxLength={80}
        className="h-7 flex-1 rounded-md border border-slate-200 bg-white px-2 text-xs outline-none focus:border-indigo-300"
      />
      <Button size="xs" type="submit" variant="outline" disabled={!name.trim()}>
        Ajouter
      </Button>
    </form>
  );
}

export function PrioritizationMatrix() {
  const { run, data, streaming } = useStageView("options");
  const working = useSession((s) => s.matrix.initiatives);
  const weights = useSession((s) => s.matrix.weights);
  const edited = useSession(matrixEdited);
  const editable = !streaming && run.data !== null;

  const rows: DeepPartial<Initiative>[] = editable ? (working ?? run.data!.initiatives) : compact(data?.initiatives);
  if (rows.length === 0) return null;

  const scores = rows.map((row) => (isCompleteInitiative(row) ? weightedScore(row, weights) : null));
  const ranking = scores
    .map((score, index) => ({ score, index }))
    .filter((x): x is { score: number; index: number } => x.score !== null)
    .sort((a, b) => b.score - a.score);
  const rankOf = new Map(ranking.map((x, position) => [x.index, position + 1]));

  const generatedPilot = run.data?.initiatives.find((i) => i.verdict === "pilot")?.name ?? null;
  const currentPilot = rows.find((i) => i.verdict === "pilot")?.name ?? null;

  return (
    <>
      <SectionTitle
        hint={editable ? "clic pour ajuster" : "1 à 5 · risque : 5 = élevé"}
        action={
          editable && (
            <>
              <Button size="xs" variant="ghost" className="h-6 text-slate-500" onClick={() => actions.matrix.sort()}>
                <ArrowDownWideNarrow /> Trier
              </Button>
              {edited && (
                <Button size="xs" variant="ghost" className="h-6 text-slate-500" onClick={() => actions.matrix.reset()}>
                  <RotateCcw /> Réinitialiser
                </Button>
              )}
            </>
          )
        }
      >
        Priorisation{edited && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800">ajustée</span>}
      </SectionTitle>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] text-slate-500 uppercase">
            <tr>
              <th className="w-6 px-1 py-1.5 font-medium">#</th>
              <th className="px-2 text-left font-medium">Initiative</th>
              {CRITERIA.map((c: Criterion) => (
                <th key={c} className="px-1 font-medium">
                  <div>{CRITERION_LABELS[c]}</div>
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() => actions.matrix.setWeight(c, (weights[c] + 1) % (MAX_WEIGHT + 1))}
                    title="Poids dans le score (clic pour changer, 0 à 3)"
                    className={cn(
                      "mt-0.5 rounded px-1 font-mono text-[10px] normal-case",
                      weights[c] === 0 ? "text-slate-300 line-through" : "text-indigo-600",
                      editable && "hover:bg-indigo-50",
                    )}
                  >
                    ×{weights[c]}
                  </button>
                </th>
              ))}
              <th className="px-1 font-medium">Score</th>
              <th className="px-2 text-left font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={index} className={cn("group", row.verdict === "pilot" && "bg-emerald-50/50")}>
                <td className="px-1 text-center font-mono text-[10px] text-slate-400">{rankOf.get(index) ?? ""}</td>
                <td className="px-2 py-1">
                  <div className="flex items-start gap-1">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-800">{row.name}</div>
                      {row.comment && <div className="text-[11px] text-slate-500">{row.comment}</div>}
                    </div>
                    {editable && (
                      <button
                        type="button"
                        aria-label={`Retirer ${row.name}`}
                        onClick={() => actions.matrix.remove(index)}
                        className="invisible text-slate-300 group-hover:visible hover:text-rose-500"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                </td>
                {CRITERIA.map((c) => (
                  <ScoreCell
                    key={c}
                    value={row[c]}
                    risk={c === "risk"}
                    onChange={editable ? (direction) => actions.matrix.cycleScore(index, c, direction) : undefined}
                  />
                ))}
                <td className="px-1 text-center font-mono text-[11px] font-semibold text-slate-700">{scores[index] ?? ""}</td>
                <td className="px-2">
                  {row.verdict && (
                    <button
                      type="button"
                      disabled={!editable}
                      title={editable ? "Clic pour changer le verdict" : undefined}
                      onClick={() => actions.matrix.cycleVerdict(index)}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
                        VERDICT_STYLES[row.verdict as Verdict],
                        editable && "hover:ring-2 hover:ring-indigo-300",
                      )}
                    >
                      {VERDICT_LABELS[row.verdict as Verdict]}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-1 text-[10px] text-slate-400">{formulaLabel(weights)} · risque : 5 = élevé</p>
      {editable && currentPilot !== generatedPilot && (
        <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {currentPilot ? (
            <>
              Pilote choisi : <strong>{currentPilot}</strong> (proposé : {generatedPilot ?? "aucun"}). Cible, roadmap et
              restitution suivront ton choix après « Mettre à jour la suite ».
            </>
          ) : (
            <>Aucun pilote sélectionné : clique sur un verdict pour en choisir un.</>
          )}
        </p>
      )}
      {editable &&
        matrixNotices(run.notes).map((notice) => (
          <p key={notice} className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            {notice}
          </p>
        ))}
      {editable && <AddInitiative />}
    </>
  );
}
