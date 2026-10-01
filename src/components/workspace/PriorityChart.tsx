"use client";

import { Fragment, useMemo, useState } from "react";
import { CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { CRITERION_FULL_LABELS, VERDICT_LABELS } from "@/lib/domain/labels";
import { CRITERIA, weightedScore } from "@/lib/domain/scoring";
import {
  BUBBLE_RADIUS,
  layoutBubbles,
  pilotReading,
  plotFrame,
  priorityToMermaid,
  QUADRANT_LABELS,
  quadrantOf,
  scoreToX,
  scoreToY,
  type Quadrant,
  type QuadrantName,
} from "@/lib/diagram/priority";
import { VERDICTS, type Initiative, type Verdict } from "@/lib/schemas/options";
import { matrixEdited } from "@/lib/store/machine";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { useElementWidth, useStageView } from "./hooks";
import { CopyButton } from "./MermaidBlock";
import { isCompleteInitiative } from "./PrioritizationMatrix";
import { Placeholder, SectionTitle } from "./Zone";

// Emphasis: the pilot wears the accent, the other verdicts an ordinal gray ramp, "avoid" an open red ring.
const MARKS: Record<Verdict, { fill: string; stroke: string }> = {
  pilot: { fill: "#059669", stroke: "#ffffff" },
  next: { fill: "#475569", stroke: "#ffffff" },
  later: { fill: "#94a3b8", stroke: "#ffffff" },
  avoid: { fill: "#ffffff", stroke: "#e11d48" },
};
const RISK_COLOR = "#d97706";
const TICKS = [1, 2, 3, 4, 5];
const HIT_RADIUS = 14;

const VERDICT_CHIPS: Record<Verdict, string> = {
  pilot: "bg-emerald-600 text-white",
  next: "bg-indigo-100 text-indigo-800",
  later: "bg-slate-100 text-slate-600",
  avoid: "bg-rose-100 text-rose-700",
};

export type Point = { row: Initiative; index: number };

function star(cx: number, cy: number, outer: number, inner: number) {
  return Array.from({ length: 10 }, (_, k) => {
    const angle = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = k % 2 === 0 ? outer : inner;
    return `${k === 0 ? "M" : "L"}${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
  }).join(" ") + " Z";
}

const riskTriangle = (x: number, y: number) => `M${x},${y - 4} L${x + 4},${y + 3} L${x - 4},${y + 3} Z`;

function Marker({ verdict }: { verdict: Verdict }) {
  const mark = MARKS[verdict];
  return (
    <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
      <circle cx={6} cy={6} r={4.5} fill={mark.fill} stroke={verdict === "avoid" ? mark.stroke : "none"} strokeWidth={1.5} />
    </svg>
  );
}

export function Legend() {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
      {VERDICTS.map((verdict) => (
        <span key={verdict} className="inline-flex items-center gap-1">
          <Marker verdict={verdict} />
          {VERDICT_LABELS[verdict]}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
          <path d={riskTriangle(6, 6.5)} fill={RISK_COLOR} />
        </svg>
        Risque élevé (4-5)
      </span>
    </div>
  );
}

const READINGS: Record<Quadrant | "fence", { tone: "good" | "warn" | "info"; text: string }> = {
  quickWin: { tone: "good", text: "est dans les quick wins : forte valeur et faisable." },
  structural: {
    tone: "warn",
    text: "est un chantier structurant : forte valeur mais difficile. Justifie-le (fondations réutilisables, apprentissage) ou prends un quick win.",
  },
  bonus: { tone: "warn", text: "est un gain d'appoint : facile mais peu de valeur, il prouvera peu." },
  deprioritize: { tone: "warn", text: "est à déprioriser : peu de valeur et difficile. À revoir." },
  fence: { tone: "info", text: "est à la frontière (une note de 3) : précise sa valeur ou sa faisabilité." },
};

export function Reading({ points }: { points: Point[] }) {
  const { pilot, otherQuickWins } = pilotReading(points.map((p) => p.row));
  if (!pilot) {
    return (
      <p className="mt-2 flex gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
        <TriangleAlert className="mt-px size-3.5 shrink-0" /> Aucun pilote : clique sur une bulle pour le choisir.
      </p>
    );
  }
  const reading = READINGS[pilot.quadrant ?? "fence"];
  const Icon = reading.tone === "good" ? CheckCircle2 : reading.tone === "warn" ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        "mt-2 rounded-md px-2 py-1.5 text-[11px]",
        reading.tone === "good" ? "bg-emerald-50 text-emerald-950" : reading.tone === "warn" ? "bg-amber-50 text-amber-950" : "bg-slate-50 text-slate-700",
      )}
    >
      <p className="flex gap-1.5">
        <Icon className="mt-px size-3.5 shrink-0" />
        <span>
          Le pilote <strong>{pilot.name}</strong> {reading.text}
        </span>
      </p>
      {otherQuickWins.length > 0 && (
        <p className="mt-0.5 pl-5 text-slate-600">Autres quick wins, candidats à la vague suivante : {otherQuickWins.join(", ")}.</p>
      )}
    </div>
  );
}

function BubbleTooltip({ point, x, y, width, canChoose }: { point: Point; x: number; y: number; width: number; canChoose: boolean }) {
  const weights = useSession((s) => s.matrix.weights);
  const { row } = point;
  const quadrant = quadrantOf(row);
  const alignX = x < 120 ? "-12%" : x > width - 120 ? "-88%" : "-50%";
  const below = y < 130;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-56 rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-lg"
      style={{ left: x, top: y, transform: `translate(${alignX}, ${below ? "18px" : "calc(-100% - 18px)"})` }}
    >
      <div className="font-semibold text-slate-900">{row.name}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
        <span className={cn("rounded px-1.5 py-px text-[10px] font-medium", VERDICT_CHIPS[row.verdict])}>{VERDICT_LABELS[row.verdict]}</span>
        {quadrant ? QUADRANT_LABELS[quadrant] : "À la frontière"}
      </div>
      <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11px]">
        {CRITERIA.map((c) => (
          <Fragment key={c}>
            <dt className="text-slate-500">
              {CRITERION_FULL_LABELS[c]}
              {c === "risk" && " (5 = élevé)"}
            </dt>
            <dd className="text-right font-mono font-semibold text-slate-900 tabular-nums">{row[c]}</dd>
          </Fragment>
        ))}
        <dt className="border-t border-slate-100 pt-0.5 text-slate-500">Score pondéré</dt>
        <dd className="border-t border-slate-100 pt-0.5 text-right font-mono font-semibold text-slate-900 tabular-nums">
          {weightedScore(row, weights)}
        </dd>
      </dl>
      {row.comment && <p className="mt-1 text-[11px] text-slate-500">{row.comment}</p>}
      {canChoose && row.verdict !== "pilot" && <p className="mt-1 text-[10px] font-medium text-indigo-700">Clic : choisir comme pilote</p>}
    </div>
  );
}

/** `fixedWidth` draws at a set size (print); otherwise the chart follows its container. */
export function Chart({ points, canChoose, fixedWidth }: { points: Point[]; canChoose: boolean; fixedWidth?: number }) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const width = fixedWidth ?? measured;
  const [active, setActive] = useState<number | null>(null);
  const height = Math.round(Math.min(380, Math.max(250, width * 0.62)));
  const frame = useMemo(() => plotFrame(width, height), [width, height]);
  const xMid = scoreToX(frame, 3);
  const yMid = scoreToY(frame, 3);

  const { bubbles: layout, quadrants } = useMemo(
    () => (width > 0 ? layoutBubbles(points.map((p) => p.row), frame) : { bubbles: [], quadrants: null }),
    [points, frame, width],
  );

  const choose = (point: Point) => {
    if (canChoose && point.row.verdict !== "pilot") actions.matrix.setVerdict(point.index, "pilot");
  };
  const hovered = active !== null ? layout[active] : undefined;

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block h-auto max-w-full select-none"
          role="group"
          aria-label="Matrice valeur × faisabilité des initiatives"
        >
          <rect x={xMid} y={frame.top} width={frame.right - xMid} height={yMid - frame.top} fill="#059669" fillOpacity={0.06} />
          <rect x={frame.left} y={frame.top} width={frame.right - frame.left} height={frame.bottom - frame.top} fill="none" stroke="#e2e8f0" />
          <line x1={xMid} x2={xMid} y1={frame.top} y2={frame.bottom} stroke="#cbd5e1" />
          <line x1={frame.left} x2={frame.right} y1={yMid} y2={yMid} stroke="#cbd5e1" />

          {TICKS.map((t) => (
            <Fragment key={t}>
              <text x={scoreToX(frame, t)} y={frame.bottom + 13} textAnchor="middle" className="fill-slate-400 text-[10px] tabular-nums">
                {t}
              </text>
              <text x={frame.left - 7} y={scoreToY(frame, t) + 3.5} textAnchor="end" className="fill-slate-400 text-[10px] tabular-nums">
                {t}
              </text>
            </Fragment>
          ))}
          <text x={(frame.left + frame.right) / 2} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[10.5px]">
            Faisabilité → (5 = facile)
          </text>
          <text
            transform={`translate(11 ${(frame.top + frame.bottom) / 2}) rotate(-90)`}
            textAnchor="middle"
            className="fill-slate-500 text-[10.5px]"
          >
            Valeur → (5 = forte)
          </text>

          {quadrants &&
            (Object.entries(quadrants) as [Quadrant, QuadrantName][]).map(([quadrant, q]) => (
              <text
                key={quadrant}
                x={q.x}
                y={q.y}
                textAnchor={q.anchor}
                className={cn("text-[9.5px] tracking-wide", quadrant === "quickWin" ? "fill-emerald-800 font-semibold" : "fill-slate-400")}
              >
                {q.text}
              </text>
            ))}

          {layout.map((b) => {
            const point = points[b.index];
            const { row } = point;
            const mark = MARKS[row.verdict];
            return (
              <g
                key={point.index}
                role="button"
                tabIndex={0}
                aria-label={`${row.name} : valeur ${row.value}, faisabilité ${row.feasibility}, risque ${row.risk}, verdict ${VERDICT_LABELS[row.verdict]}`}
                className={cn("outline-none", canChoose && row.verdict !== "pilot" && "cursor-pointer")}
                onMouseEnter={() => setActive(b.index)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(b.index)}
                onBlur={() => setActive(null)}
                onClick={() => choose(point)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(point);
                  }
                }}
              >
                <circle cx={b.cx} cy={b.cy} r={HIT_RADIUS} fill="transparent" />
                {active === b.index && (
                  <circle cx={b.cx} cy={b.cy} r={BUBBLE_RADIUS + 4} fill="none" stroke="#0f172a" strokeOpacity={0.35} strokeWidth={1.5} />
                )}
                <circle cx={b.cx} cy={b.cy} r={BUBBLE_RADIUS} fill={mark.fill} stroke={mark.stroke} strokeWidth={2} />
                {row.verdict === "pilot" && <path d={star(b.cx, b.cy, 5, 2.2)} fill="#ffffff" />}
                {row.verdict === "avoid" && (
                  <path
                    d={`M${b.cx - 3},${b.cy - 3} L${b.cx + 3},${b.cy + 3} M${b.cx + 3},${b.cy - 3} L${b.cx - 3},${b.cy + 3}`}
                    stroke={mark.stroke}
                    strokeWidth={1.6}
                    strokeLinecap="round"
                  />
                )}
                {row.risk >= 4 && <path d={riskTriangle(b.cx + 9, b.cy - 9)} fill={RISK_COLOR} stroke="#ffffff" strokeWidth={1} />}
                <text
                  x={b.label.x}
                  y={b.label.y}
                  textAnchor={b.label.anchor}
                  className={cn("text-[11px]", row.verdict === "pilot" ? "fill-slate-900 font-semibold" : "fill-slate-600")}
                >
                  {b.label.text}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hovered && active !== null && (
        <BubbleTooltip point={points[active]} x={hovered.cx} y={hovered.cy} width={width} canChoose={canChoose} />
      )}
    </div>
  );
}

export function PriorityChart() {
  const { run, streaming } = useStageView("options");
  const working = useSession((s) => s.matrix.initiatives);
  const edited = useSession(matrixEdited);
  const ready = !streaming && run.data !== null;

  const points = useMemo<Point[]>(() => {
    if (!ready) return [];
    return (working ?? run.data!.initiatives)
      .map((row, index) => ({ row, index }))
      .filter((p) => isCompleteInitiative(p.row) && (VERDICTS as readonly string[]).includes(p.row.verdict));
  }, [ready, working, run.data]);

  if (!ready) {
    return <Placeholder>{streaming ? "La matrice se remplit avec l'étape Options…" : "La matrice valeur × faisabilité arrive avec l'étape Options."}</Placeholder>;
  }
  if (points.length === 0) return <Placeholder>Aucune initiative à placer.</Placeholder>;

  return (
    <>
      <SectionTitle
        hint="une bulle = une initiative"
        action={<CopyButton text={priorityToMermaid(points.map((p) => p.row))} />}
      >
        Valeur × faisabilité
        {edited && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800">ajustée</span>}
      </SectionTitle>
      <Chart points={points} canChoose={ready} />
      <Legend />
      <Reading points={points} />
      <p className="mt-1.5 text-[10px] text-slate-400">
        Survol : le détail · clic : choisir le pilote. Mêmes données que le tableau de priorisation : tes ajustements s&apos;y reflètent.
      </p>
    </>
  );
}
