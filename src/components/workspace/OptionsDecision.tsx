"use client";

import { useMemo } from "react";
import { ArrowRight, Check, Star, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { FIT_LABELS } from "@/lib/domain/labels";
import { pivotsToMermaid } from "@/lib/diagram/pivots";
import { FITS, type Fit, type OptionsAnalysis } from "@/lib/schemas/options";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { compact, useStageView, type DeepPartial } from "./hooks";
import { MermaidBlock, type Zoom } from "./MermaidBlock";
import { BasisChips } from "./SourceChip";
import { Placeholder, SectionTitle } from "./Zone";

type OptionHead = { id: string; name: string };

const FIT_STYLES: Record<Fit, { icon: LucideIcon; className: string }> = {
  pass: { icon: Check, className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  partial: { icon: TriangleAlert, className: "bg-amber-50 text-amber-800 ring-amber-200" },
  fail: { icon: X, className: "bg-rose-50 text-rose-700 ring-rose-200" },
};

const isFit = (value: unknown): value is Fit => (FITS as readonly unknown[]).includes(value);

function FitCell({ fit, note, inlineNotes = false }: { fit: unknown; note?: string; inlineNotes?: boolean }) {
  if (!isFit(fit)) return <span className="text-slate-300">—</span>;
  const { icon: Icon, className } = FIT_STYLES[fit];
  const mark = (
    <span className={cn("inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium ring-1 ring-inset", className)}>
      <Icon className="size-3" aria-hidden />
      {fit === "pass" ? <span className="sr-only">{FIT_LABELS.pass}</span> : FIT_LABELS[fit]}
    </span>
  );
  // A pass rarely needs explaining: its note waits in a tooltip; conditions and blockers are spelled out.
  if (fit === "pass" && !inlineNotes) {
    return note ? (
      <Tooltip>
        <TooltipTrigger asChild>{mark}</TooltipTrigger>
        <TooltipContent className="max-w-xs">{note}</TooltipContent>
      </Tooltip>
    ) : (
      mark
    );
  }
  return (
    <div>
      {mark}
      {note && <p className="mt-0.5 text-[10px] leading-snug text-slate-600">{note}</p>}
    </div>
  );
}

/** Harvey ball: empty at 1, full at 5. */
function HarveyBall({ score }: { score: number }) {
  const fraction = Math.min(1, Math.max(0, (score - 1) / 4));
  const c = 7;
  const r = 5.5;
  const angle = fraction * 2 * Math.PI;
  const wedge =
    fraction > 0 && fraction < 1
      ? `M${c},${c} L${c},${c - r} A${r},${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${(c + r * Math.sin(angle)).toFixed(2)},${(c - r * Math.cos(angle)).toFixed(2)} Z`
      : null;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0" aria-hidden>
      <circle cx={c} cy={c} r={r} fill="#ffffff" stroke="#94a3b8" strokeWidth={1.25} />
      {fraction >= 1 && <circle cx={c} cy={c} r={r} fill="#4f46e5" />}
      {wedge && <path d={wedge} fill="#4f46e5" />}
    </svg>
  );
}

function ScoreCell({ score, best }: { score: unknown; best: boolean }) {
  if (typeof score !== "number") return <span className="text-slate-300">—</span>;
  return (
    <span className="inline-flex items-center gap-1" title={`${score} sur 5`}>
      <HarveyBall score={score} />
      <span className={cn("font-mono text-[11px] tabular-nums", best ? "font-semibold text-slate-900" : "text-slate-500")}>{score}</span>
    </span>
  );
}

function GroupRow({ span, children }: { span: number; children: string }) {
  return (
    <tr>
      <td colSpan={span} className="bg-slate-50/70 px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
        {children}
      </td>
    </tr>
  );
}

export function Comparison({
  options,
  comparison,
  recommended,
  streaming,
  inlineNotes = false,
}: {
  options: OptionHead[];
  comparison: DeepPartial<OptionsAnalysis["comparison"]> | undefined;
  recommended: string | null;
  streaming: boolean;
  inlineNotes?: boolean;
}) {
  const constraints = compact(comparison?.constraints).filter((c) => c.label);
  const criteria = compact(comparison?.criteria).filter((c) => c.label);

  const blocked = new Set<string>();
  for (const c of constraints) for (const f of compact(c.fits)) if (f.fit === "fail" && f.optionId) blocked.add(f.optionId);

  const title = <SectionTitle hint="avant de choisir">Options × critères</SectionTitle>;
  if (constraints.length + criteria.length === 0) {
    return (
      <>
        {title}
        <Placeholder>
          {streaming ? "La comparaison se remplit…" : "Pas de comparaison pour cette analyse : régénère l'étape Options (↻) pour l'obtenir."}
        </Placeholder>
      </>
    );
  }

  const span = options.length + 1;
  const column = (id: string) => cn(id === recommended && "bg-indigo-50/60");
  return (
    <>
      {title}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[360px] table-fixed text-xs">
          <colgroup>
            <col className="w-[36%]" />
            {options.map((o) => (
              <col key={o.id} />
            ))}
          </colgroup>
          <thead className="align-bottom">
            <tr className="border-b border-slate-200">
              <th className="px-2 py-1.5 text-left text-[10px] font-medium text-slate-400 uppercase">Option</th>
              {options.map((o) => (
                <th key={o.id} scope="col" className={cn("px-1.5 py-1.5 text-left font-medium", column(o.id))}>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-mono text-[10px] text-slate-400">{o.id}</span>
                    {o.id === recommended && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-indigo-700 px-1 py-px text-[9px] font-medium text-white">
                        <Star className="size-2.5" aria-hidden /> Reco
                      </span>
                    )}
                    {blocked.has(o.id) && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-rose-100 px-1 py-px text-[9px] font-medium text-rose-700">
                        <X className="size-2.5" aria-hidden /> Bloquée
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] leading-tight text-slate-800">{o.name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {constraints.length > 0 && <GroupRow span={span}>Contraintes · passe ou bloque</GroupRow>}
            {constraints.map((c, i) => (
              <tr key={`k${i}`} className="border-t border-slate-100">
                <th scope="row" className="px-2 py-1.5 text-left align-top font-normal">
                  <div className="text-slate-800">{c.label}</div>
                  {compact(c.basis).length > 0 && (
                    <div className="mt-0.5">
                      <BasisChips basis={compact(c.basis)} />
                    </div>
                  )}
                </th>
                {options.map((o) => {
                  const fit = compact(c.fits).find((f) => f.optionId === o.id);
                  return (
                    <td key={o.id} className={cn("px-1.5 py-1.5 align-top", column(o.id))}>
                      <FitCell fit={fit?.fit} note={fit?.note} inlineNotes={inlineNotes} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {criteria.length > 0 && <GroupRow span={span}>Critères · de 1 à 5, 5 = meilleur</GroupRow>}
            {criteria.map((c, i) => {
              const scores = options.map((o) => compact(c.scores).find((s) => s.optionId === o.id)?.score);
              const numbers = scores.filter((s): s is NonNullable<typeof s> => typeof s === "number");
              const best = numbers.length > 1 ? Math.max(...numbers) : null;
              return (
                <tr key={`c${i}`} className="border-t border-slate-100">
                  <th scope="row" className="px-2 py-1.5 text-left font-normal text-slate-800">
                    {c.label}
                  </th>
                  {options.map((o, j) => (
                    <td key={o.id} className={cn("px-1.5 py-1.5", column(o.id), blocked.has(o.id) && "opacity-45")}>
                      <ScoreCell score={scores[j]} best={best !== null && scores[j] === best} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-slate-400">
        Une option bloquée par une contrainte sort de la course, ses notes sont grisées. Meilleure note de chaque ligne en gras.
      </p>
    </>
  );
}

export function PivotLegend() {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-[3px] w-5 rounded-full bg-indigo-600" /> ce que l&apos;on suppose aujourd&apos;hui
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-5 border-t-2 border-dotted border-slate-500" /> si la réponse est autre
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-amber-600 bg-amber-50" /> recommandation à adapter
      </span>
    </div>
  );
}

function Pivots({ options, zoom }: { options: OptionHead[]; zoom: Zoom }) {
  const { run, data, streaming } = useStageView("options");
  const final = streaming ? null : run.data;
  const code = useMemo(() => (final ? pivotsToMermaid(final) : null), [final]);
  const pivots = compact(data?.recommendation?.pivots).filter((p) => p.question);
  const names = new Map(options.map((o) => [o.id, o.name]));
  const recoId = data?.recommendation?.optionId ?? null;
  const recoLabel = recoId && names.get(recoId) ? `${recoId} · ${names.get(recoId)}` : "la recommandation actuelle";

  const title = (
    <SectionTitle hint="la robustesse de la recommandation">Ce qui ferait changer ma recommandation</SectionTitle>
  );
  if (pivots.length === 0) {
    if (streaming) return null;
    return (
      <>
        {title}
        <Placeholder>Pas de points de bascule pour cette analyse : régénère l&apos;étape Options (↻) pour les obtenir.</Placeholder>
      </>
    );
  }

  return (
    <>
      {title}
      <MermaidBlock code={code} zoom={zoom} placeholder="L'arbre se dessine…" legend={<PivotLegend />} />
      <ul className="mt-2 space-y-1.5">
        {pivots.map((p, i) => {
          const alternative = p.thenOptionId ? names.get(p.thenOptionId) : undefined;
          return (
            <li key={i} className="rounded-lg border border-slate-200 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                {p.basis && <BasisChips basis={[p.basis]} />}
                <span className="font-semibold text-slate-800">{p.question}</span>
              </div>
              <div className="mt-1 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5 text-slate-600">
                <span className="text-[10px] font-medium text-indigo-700 uppercase">Aujourd&apos;hui</span>
                <span>
                  {p.assumed} <ArrowRight className="inline size-3 text-indigo-500" aria-hidden /> <strong className="text-slate-800">{recoLabel}</strong>
                </span>
                <span className="text-[10px] font-medium text-slate-500 uppercase">Sinon</span>
                <span>
                  {p.ifInstead} <ArrowRight className="inline size-3 text-slate-400" aria-hidden />{" "}
                  <strong className="text-slate-800">
                    {p.thenOptionId && alternative ? `${p.thenOptionId} · ${alternative}` : `${recoId ?? "Recommandation"} adaptée`}
                  </strong>
                </span>
              </div>
              {p.consequence && <p className="mt-1 text-[11px] text-slate-500">{p.consequence}</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function OptionsDecision({ zoom }: { zoom: Zoom }) {
  const { data, streaming } = useStageView("options");
  const options = compact(data?.options).filter((o): o is OptionHead => typeof o.id === "string" && typeof o.name === "string");

  if (options.length === 0) {
    return (
      <Placeholder>
        {streaming ? "Les options arrivent…" : "La comparaison des options arrive avec l'étape Options, après le diagnostic."}
      </Placeholder>
    );
  }
  return (
    <>
      <Comparison
        options={options}
        comparison={data?.comparison}
        recommended={data?.recommendation?.optionId ?? null}
        streaming={streaming}
      />
      <Pivots options={options} zoom={zoom} />
    </>
  );
}
