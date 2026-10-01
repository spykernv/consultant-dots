"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Printer, X } from "lucide-react";
import { pivotsToMermaid } from "@/lib/diagram/pivots";
import { toMermaid } from "@/lib/diagram/to-mermaid";
import { domainLabel } from "@/lib/domain/domains";
import {
  BACKBONE_LABELS,
  CHALLENGE_LEVEL_LABELS,
  CONSTRAINT_LABELS,
  CRITERION_FULL_LABELS,
  KPI_TYPE_LABELS,
  SEVERITY_LABELS,
  SOURCE_LABELS,
  VERDICT_LABELS,
} from "@/lib/domain/labels";
import { REFLEXES } from "@/lib/domain/reflexes";
import { CRITERIA, formulaLabel, weightedScore } from "@/lib/domain/scoring";
import { exportFilename } from "@/lib/export/download";
import { formatDate, staleSections, ZONE_TITLES } from "@/lib/export/markdown";
import { buildSynthesis } from "@/lib/export/synthesis";
import { buildCaseBrief, sourceOfBasis } from "@/lib/prompts/brief";
import type { StageId } from "@/lib/schemas";
import { EMPTY_COMPARISON, VERDICTS } from "@/lib/schemas/options";
import { clarificationList, effectiveOptions, matrixEdited, ZONE_KEYS, type Session } from "@/lib/store/machine";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MermaidView } from "@/components/mermaid/MermaidView";
import { Legend as DiagramLegend } from "@/components/workspace/DiagramsPanel";
import { Comparison, PivotLegend } from "@/components/workspace/OptionsDecision";
import { isCompleteInitiative } from "@/components/workspace/PrioritizationMatrix";
import { Chart, Legend as ChartLegend, Reading, type Point } from "@/components/workspace/PriorityChart";

// ── Building blocks ─────────────────────────────────────────────────────────

function Section({ title, stale, children }: { title: string; stale?: string | null; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-2 border-b-2 border-indigo-600 pb-1 text-[15px] font-semibold text-slate-900 break-after-avoid">{title}</h2>
      {stale && (
        <p className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-amber-950 break-inside-avoid">
          <strong>⚠️ Section à mettre à jour :</strong> {stale}
        </p>
      )}
      {children}
    </section>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <h3 className="mt-3 mb-1 text-[10.5px] font-semibold tracking-wide text-slate-500 uppercase break-after-avoid">{children}</h3>;
}

function Bullets({ items, ordered = false }: { items: ReactNode[]; ordered?: boolean }) {
  if (items.length === 0) return null;
  const List = ordered ? "ol" : "ul";
  return (
    <List className={cn("space-y-0.5 pl-4", ordered ? "list-decimal" : "list-disc marker:text-slate-400")}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </List>
  );
}

function Figure({ code, legend }: { code: string; legend?: ReactNode }) {
  return (
    <figure className="my-2 break-inside-avoid">
      <MermaidView code={code} fit className="flex justify-center" />
      {legend}
    </figure>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-slate-500">{children}</span>;

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="my-1 w-full border-collapse text-[10.5px]">
      <thead>
        <tr className="border-b border-slate-300 text-left text-[9.5px] tracking-wide text-slate-500 uppercase">
          {head.map((h) => (
            <th key={h} className="px-1.5 py-1 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-slate-100 align-top break-inside-avoid">
            {row.map((cell, j) => (
              <td key={j} className="px-1.5 py-1">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── The report ──────────────────────────────────────────────────────────────

function Report({ s, synthesis, now }: { s: Session; synthesis: ReturnType<typeof buildSynthesis>; now: Date }) {
  const classification = s.stages.classify.data;
  const mapping = s.stages.frame.data;
  const questions = s.stages.questions.data;
  const diagnostic = s.stages.diagnose.data;
  const current = s.stages.currentState.data;
  const options = effectiveOptions(s);
  const target = s.stages.target.data;
  const roadmap = s.stages.roadmap.data;
  const oral = s.stages.oral.data;
  const challenge = s.stages.challenge.data;

  const brief = useMemo(
    () =>
      classification && mapping && questions
        ? buildCaseBrief({
            caseText: s.caseText,
            classification,
            mapping,
            questions,
            clarifications: clarificationList(s),
            clientNotes: s.clientNotes,
          })
        : null,
    [s, classification, mapping, questions],
  );
  const stale = useMemo(() => staleSections(s), [s]);
  // A section that no longer matches the session says why, as in the Markdown export.
  const staleOf = (stage: StageId) => stale.get(stage) ?? null;
  const sourceOf = (basis: string[]) => (brief ? SOURCE_LABELS[sourceOfBasis(basis, brief)].toLowerCase() : "");
  const tag = (source: "case" | "assumption") => (source === "case" ? "fait" : "hypothèse");

  const points: Point[] = (options?.initiatives ?? [])
    .map((row, index) => ({ row, index }))
    .filter((p) => isCompleteInitiative(p.row) && (VERDICTS as readonly string[]).includes(p.row.verdict));
  const ranked = [...(options?.initiatives ?? [])].sort((a, b) => weightedScore(b, s.matrix.weights) - weightedScore(a, s.matrix.weights));
  const pivotsCode = options ? pivotsToMermaid(options) : null;
  const names = new Map(options?.options.map((o) => [o.id, o.name]));
  const notes = ZONE_KEYS.filter((zone) => s.notes[zone]?.trim());

  return (
    <article className="text-[11.5px] leading-relaxed text-slate-800">
      <header className="border-b border-slate-200 pb-3">
        <div className="flex items-baseline justify-between text-[9.5px] tracking-[0.14em] text-slate-400 uppercase">
          <span>Consultant Dots</span>
          <span>{formatDate(now)}</span>
        </div>
        <h1 className="mt-2 text-[20px] leading-snug font-semibold text-slate-900">
          Business case{classification ? ` · ${domainLabel(classification.primaryDomain)}` : ""}
        </h1>
        {classification && (
          <p className="mt-1 text-[11px] text-slate-500">
            Type de case : <strong className="text-slate-700">{domainLabel(classification.primaryDomain)}</strong> (
            {Math.round(classification.confidence)} %)
            {classification.secondaryDomains.length > 0 && ` · secondaires : ${classification.secondaryDomains.map(domainLabel).join(", ")}`}
          </p>
        )}
      </header>

      {synthesis.length > 0 && (
        <section className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50/70 p-4 break-inside-avoid">
          <h2 className="text-[12px] font-semibold tracking-[0.12em] text-indigo-900 uppercase">Synthèse</h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
            {synthesis.map((line) => (
              <Fragment key={line.label}>
                <dt className="font-semibold whitespace-nowrap text-indigo-900">{line.label}</dt>
                <dd
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  className="rounded px-0.5 text-slate-900 outline-none hover:bg-white/70 focus:bg-white focus:ring-2 focus:ring-indigo-300"
                >
                  {line.text}
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}

      <Section title="Le case">
        <blockquote className="border-l-2 border-slate-300 pl-3 text-[10.5px] whitespace-pre-line text-slate-600">{s.caseText}</blockquote>
      </Section>

      {mapping && (
        <Section title="Cadrage" stale={staleOf("frame")}>
          {mapping.premiseChallenge && (
            <p className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-amber-950">
              <strong>Recadrage :</strong> {mapping.premiseChallenge}
            </p>
          )}
          <div className="grid grid-cols-2 gap-x-6">
            <div>
              <Sub>Objectifs business</Sub>
              <Bullets items={mapping.businessObjectives.map((o) => <>{o.text} <Muted>({tag(o.source)})</Muted></>)} />
              <Sub>Pain points</Sub>
              <Bullets items={mapping.painPoints} />
            </div>
            <div>
              <Sub>Contraintes</Sub>
              <Bullets
                items={mapping.constraints.map((c) => (
                  <>
                    <strong>{CONSTRAINT_LABELS[c.type]}</strong> — {c.text} <Muted>({tag(c.source)})</Muted>
                  </>
                ))}
              />
              <Sub>Parties prenantes</Sub>
              <Bullets items={mapping.stakeholders.map((p) => <><strong>{p.name}</strong> — {p.role}</>)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-6">
            <div>
              <Sub>Faits (énoncé)</Sub>
              <Bullets items={mapping.facts.map((f) => <><strong>{f.id}</strong> {f.text}</>)} />
            </div>
            <div>
              <Sub>Hypothèses</Sub>
              <Bullets items={(brief?.assumptions ?? mapping.assumptions).map((a) => <><strong>{a.id}</strong> {a.text}</>)} />
            </div>
          </div>
        </Section>
      )}

      {questions && brief && (
        <Section title="Questions de clarification" stale={staleOf("questions")}>
          <Table
            head={["", "Question", "Réponse retenue", "Décision impactée"]}
            rows={questions.questions.map((q) => {
              const c = brief.clarifications.find((x) => x.id === q.id);
              return [
                <strong key="id">{q.id}</strong>,
                q.question,
                c?.source === "client" ? (
                  <>
                    <strong>Client :</strong> {c.answer}
                  </>
                ) : (
                  <>
                    <Muted>Hypothèse :</Muted> {q.defaultAssumption}
                  </>
                ),
                q.decisionImpact,
              ];
            })}
          />
        </Section>
      )}

      {diagnostic && (
        <Section title="Diagnostic" stale={staleOf("diagnose")}>
          <Sub>Démarche</Sub>
          <Bullets
            ordered
            items={diagnostic.framework.map((f) => (
              <>
                <strong>{f.step}</strong> <Muted>({BACKBONE_LABELS[f.backbone]})</Muted> — {f.focus}
              </>
            ))}
          />
          <Sub>Constats</Sub>
          <Bullets
            items={diagnostic.findings.map((f) => (
              <>
                <strong>{f.dimension}</strong> — {f.finding}{" "}
                <Muted>
                  ({sourceOf(f.basis)}
                  {f.basis.length ? ` : ${f.basis.join(", ")}` : ""})
                </Muted>
              </>
            ))}
          />
          <Sub>Causes racines</Sub>
          <Bullets ordered items={diagnostic.rootCauses} />
          <p className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1.5 font-medium text-indigo-950 break-inside-avoid">
            {diagnostic.keyInsight}
          </p>
        </Section>
      )}

      {current && (
        <Section title="Schéma de l'existant" stale={staleOf("currentState")}>
          <Figure code={toMermaid(current.diagram)} legend={<DiagramLegend />} />
          <Sub>Goulots d&apos;étranglement</Sub>
          <Bullets items={current.bottlenecks} />
        </Section>
      )}

      {options && (
        <Section title="Options et recommandation" stale={staleOf("options")}>
          <div className="grid grid-cols-3 gap-2">
            {options.options.map((o) => (
              <div
                key={o.id}
                className={cn(
                  "rounded-md border p-2 text-[10.5px] break-inside-avoid",
                  o.id === options.recommendation.optionId ? "border-indigo-300 bg-indigo-50/60" : "border-slate-200",
                )}
              >
                <div className="font-semibold text-slate-900">
                  {o.id} · {o.name}
                  {o.id === options.recommendation.optionId && <span className="ml-1 text-indigo-700">★ recommandée</span>}
                </div>
                <p className="text-slate-600">{o.description}</p>
                <ul className="mt-1 space-y-0.5">
                  {o.advantages.map((a, i) => (
                    <li key={`a${i}`}>
                      <span className="font-semibold text-emerald-700">+</span> {a}
                    </li>
                  ))}
                  {o.drawbacks.map((d, i) => (
                    <li key={`d${i}`}>
                      <span className="font-semibold text-rose-700">−</span> {d}
                    </li>
                  ))}
                </ul>
                {o.conditions.length > 0 && <p className="mt-1 text-slate-500">Si : {o.conditions.join(" · ")}</p>}
              </div>
            ))}
          </div>

          <div className="mt-3 break-inside-avoid">
            <Comparison
              options={options.options}
              comparison={options.comparison ?? EMPTY_COMPARISON}
              recommended={options.recommendation.optionId}
              streaming={false}
              inlineNotes
            />
          </div>

          <div className="mt-3 rounded-md border border-indigo-200 p-2.5 break-inside-avoid">
            <p className="text-[12.5px] font-semibold text-indigo-950">{options.recommendation.statement}</p>
            <p className="mt-1 text-slate-700">{options.recommendation.rationale}</p>
            {options.recommendation.dependsOn.length > 0 && (
              <p className="mt-1 text-[10.5px] text-amber-800">Dépend de : {options.recommendation.dependsOn.join(", ")}</p>
            )}
          </div>

          {pivotsCode && (
            <>
              <Sub>Ce qui ferait changer ma recommandation</Sub>
              <Figure code={pivotsCode} legend={<PivotLegend />} />
              <Bullets
                items={(options.recommendation.pivots ?? []).map((p) => (
                  <>
                    <strong>
                      {p.basis ? `${p.basis} · ` : ""}
                      {p.question}
                    </strong>{" "}
                    Aujourd&apos;hui : {p.assumed}. Sinon ({p.ifInstead}) →{" "}
                    <strong>
                      {p.thenOptionId && names.get(p.thenOptionId)
                        ? `${p.thenOptionId} · ${names.get(p.thenOptionId)}`
                        : `${options.recommendation.optionId ?? "recommandation"} adaptée`}
                    </strong>
                    {p.consequence ? ` : ${p.consequence}` : ""}
                  </>
                ))}
              />
            </>
          )}
        </Section>
      )}

      {options && options.initiatives.length > 0 && (
        <Section title="Priorisation" stale={staleOf("options")}>
          <Table
            head={["Initiative", ...CRITERIA.map((c) => CRITERION_FULL_LABELS[c]), "Score", "Verdict"]}
            rows={ranked.map((i) => [
              <>
                <strong>{i.name}</strong>
                {i.comment && <div className="text-slate-500">{i.comment}</div>}
              </>,
              ...CRITERIA.map((c) => <span key={c} className="font-mono tabular-nums">{i[c]}</span>),
              <strong key="score" className="font-mono tabular-nums">{weightedScore(i, s.matrix.weights)}</strong>,
              <span key="verdict" className={cn(i.verdict === "pilot" && "font-semibold text-emerald-700")}>
                {VERDICT_LABELS[i.verdict]}
              </span>,
            ])}
          />
          <p className="text-[10px] text-slate-500">
            {formulaLabel(s.matrix.weights)} · risque : 5 = élevé{matrixEdited(s) ? " · priorisation ajustée par moi" : ""}
          </p>
          {points.length > 0 && (
            <div className="mt-3 break-inside-avoid">
              <Sub>Valeur × faisabilité</Sub>
              <Chart points={points} canChoose={false} fixedWidth={680} />
              <ChartLegend />
              <Reading points={points} />
            </div>
          )}
          {options.traps.length > 0 && (
            <>
              <Sub>Pièges à éviter</Sub>
              <Bullets
                items={options.traps.map((t) => (
                  <>
                    <strong>
                      {t.reflex} · {REFLEXES[t.reflex].titleFr}
                    </strong>{" "}
                    — {t.whyHere}
                  </>
                ))}
              />
            </>
          )}
        </Section>
      )}

      {target && (
        <Section title="Cible" stale={staleOf("target")}>
          <Sub>Principes</Sub>
          <Bullets items={target.principles} />
          <Figure code={toMermaid(target.diagram)} legend={<DiagramLegend />} />
          <div className="grid grid-cols-2 gap-x-6">
            <div>
              <Sub>Avant → après</Sub>
              <Bullets items={target.keyChanges.map((c) => <>{c.from} → <strong>{c.to}</strong></>)} />
            </div>
            <div>
              <Sub>Modèle opérationnel</Sub>
              <Bullets items={target.operatingModel} />
            </div>
          </div>
        </Section>
      )}

      {roadmap && (
        <Section title="Roadmap" stale={staleOf("roadmap")}>
          <div className="space-y-2">
            {roadmap.phases.map((phase, i) => (
              <div key={i} className="rounded-md border border-slate-200 p-2 text-[10.5px] break-inside-avoid">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-[11.5px] text-slate-900">{phase.name}</strong>
                  <span className="text-slate-500">{phase.timing}</span>
                </div>
                <p className="text-slate-700">{phase.objective}</p>
                <div className="mt-1 grid grid-cols-2 gap-x-4">
                  <div>
                    <Muted>Actions</Muted>
                    <Bullets items={phase.actions} />
                  </div>
                  <div>
                    <Muted>Livrables</Muted>
                    <Bullets items={phase.deliverables} />
                  </div>
                  <div>
                    <Muted>Décisions</Muted>
                    <Bullets items={phase.decisions} />
                  </div>
                  <div>
                    <Muted>KPIs</Muted>
                    <Bullets items={phase.kpis} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50/60 p-2.5 break-inside-avoid">
            <p className="font-semibold text-emerald-950">Pilote : {roadmap.pilot.initiative}</p>
            <p>
              <Muted>Périmètre :</Muted> {roadmap.pilot.scope}
            </p>
            <p className="text-slate-700">{roadmap.pilot.why}</p>
            <Bullets items={roadmap.pilot.successCriteria.map((c) => <>✓ {c}</>)} />
            <p className="mt-1 text-[10.5px] text-slate-500">Fondations réutilisables : {roadmap.pilot.reusableFoundations.join(" · ")}</p>
          </div>

          <Sub>KPIs</Sub>
          <Table
            head={["Type", "KPI", "Baseline", "Cible"]}
            rows={roadmap.kpis.map((k) => [KPI_TYPE_LABELS[k.type], <strong key="n">{k.name}</strong>, k.baseline, k.target])}
          />
          <Sub>Risques</Sub>
          <Table head={["Risque", "Impact", "Parade"]} rows={roadmap.risks.map((r) => [r.risk, r.impact, r.mitigation])} />
        </Section>
      )}

      {oral && (
        <Section title={`Restitution orale (${oral.duration})`} stale={staleOf("oral")}>
          <p className="italic">« {oral.opening} »</p>
          {oral.sections.map((section, i) => (
            <div key={i} className="break-inside-avoid">
              <Sub>
                {i + 1}. {section.title}
              </Sub>
              <Bullets
                items={section.bullets.map((b) => (
                  <>
                    <strong>{b.point}</strong> <Muted>— {b.detail}</Muted>
                  </>
                ))}
              />
            </div>
          ))}
          <p className="mt-2 italic">« {oral.closing} »</p>
          {oral.differentiators.length > 0 && (
            <>
              <Sub>Les points qui font la différence</Sub>
              <Bullets
                items={oral.differentiators.map((d) => (
                  <>
                    <strong>{d.point}</strong> — « {d.howToSayIt} »
                  </>
                ))}
              />
            </>
          )}
        </Section>
      )}

      {notes.length > 0 && (
        <Section title="Mes notes">
          {notes.map((zone) => (
            <div key={zone} className="break-inside-avoid">
              <Sub>{ZONE_TITLES[zone]}</Sub>
              <p className="whitespace-pre-line">{s.notes[zone]!.trim()}</p>
            </div>
          ))}
        </Section>
      )}

      {challenge && s.challengeAnswer.trim() && (
        <Section title="Challenge de ma réponse" stale={staleOf("challenge")}>
          <p>
            <strong>Niveau : {CHALLENGE_LEVEL_LABELS[challenge.level]}</strong> — {challenge.verdict}
          </p>
          <Sub>Points à corriger</Sub>
          <Bullets
            items={challenge.flags.map((f) => (
              <>
                <strong>
                  {f.reflex} · {REFLEXES[f.reflex].titleFr}
                </strong>{" "}
                <Muted>({SEVERITY_LABELS[f.severity].toLowerCase()})</Muted> — {f.issue} <Muted>À dire plutôt :</Muted> {f.fix}
              </>
            ))}
          />
          <div className="grid grid-cols-2 gap-x-6">
            <div>
              <Sub>Points forts</Sub>
              <Bullets items={challenge.strengths} />
            </div>
            <div>
              <Sub>Prochaine version</Sub>
              <Bullets items={challenge.nextVersion} />
            </div>
          </div>
        </Section>
      )}

      <footer className="mt-8 border-t border-slate-200 pt-2 text-[9.5px] text-slate-400">
        Consultant Dots · analyse structurée avec Claude · usage personnel
      </footer>
    </article>
  );
}

/** Full-screen preview of the PDF report; the browser's print dialog saves it ("Enregistrer au format PDF"). */
export function ReportPreview({ onClose }: { onClose: () => void }) {
  const session = useSession((s) => s);
  // Taken once: the synthesis is editable in place, and a re-render must not undo the user's edits.
  const [synthesis] = useState(() => buildSynthesis(useSession.getState()));
  const [now] = useState(() => new Date());

  // The workspace only renders client-side, so document.body is there for the portal.
  useEffect(() => {
    const previousTitle = document.title;
    // Chrome names the PDF after the page title.
    document.title = exportFilename(useSession.getState(), "", now);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.title = previousTitle;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, now]);

  return createPortal(
    <div className="report-root fixed inset-0 z-[60] overflow-auto bg-slate-300/80">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white/95 px-4 py-2 shadow-sm print:hidden">
        <span className="text-sm font-semibold text-slate-900">Rapport PDF</span>
        <span className="text-xs text-slate-500">
          Clique sur une ligne de la synthèse pour la retoucher, puis « Imprimer / PDF » et choisis « Enregistrer au format PDF ».
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => window.print()}>
            <Printer /> Imprimer / PDF
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X /> Fermer
          </Button>
        </div>
      </div>
      <div className="report-page mx-auto my-6 bg-white shadow-xl">
        <Report s={session} synthesis={synthesis} now={now} />
      </div>
    </div>,
    document.body,
  );
}
