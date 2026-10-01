import { pivotsToMermaid } from "@/lib/diagram/pivots";
import { priorityToMermaid } from "@/lib/diagram/priority";
import { toMermaid } from "@/lib/diagram/to-mermaid";
import { domainLabel } from "@/lib/domain/domains";
import {
  BACKBONE_LABELS,
  CHALLENGE_LEVEL_LABELS,
  CONSTRAINT_LABELS,
  KPI_TYPE_LABELS,
  SEVERITY_LABELS,
  SOURCE_LABELS,
  VERDICT_LABELS,
} from "@/lib/domain/labels";
import { REFLEXES } from "@/lib/domain/reflexes";
import { CRITERIA, formulaLabel, weightedScore } from "@/lib/domain/scoring";
import { buildCaseBrief, sourceOfBasis } from "@/lib/prompts/brief";
import { STAGE_IDS, type StageId } from "@/lib/schemas";
import { MIN_CHALLENGE_CHARS } from "@/lib/schemas/api";
import { EMPTY_COMPARISON, type Fit } from "@/lib/schemas/options";
import {
  clarificationList,
  effectiveOptions,
  isStale,
  matrixEdited,
  ZONE_KEYS,
  type Session,
  type ZoneKey,
} from "@/lib/store/machine";

export const ZONE_TITLES: Record<ZoneKey, string> = {
  case: "Le case",
  reasoning: "Raisonnement",
  diagrams: "Schémas",
  roadmap: "Roadmap",
  oral: "Oral & challenge",
};

const cell = (text: string | number) => String(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const quote = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

const FIT_MARKS: Record<Fit, string> = { pass: "✓", partial: "⚠", fail: "✗" };

const STALE_NOTES = {
  inputs: "générée avant tes dernières modifications (clarification, pilote ou section en amont).",
  answer: "ta réponse a changé depuis ce challenge, ses remarques portent sur la version précédente.",
  rerun: "nouvelle version lancée mais pas terminée : ce contenu est celui de la version précédente.",
};

/**
 * The sections that no longer match the session, with why, said right under their heading (Markdown export and PDF
 * report): generated before the user's latest changes, or kept from the previous version while the new one is
 * waiting, running, stopped or failed.
 */
export function staleSections(s: Session): Map<StageId, string> {
  const stale = new Map<StageId, string>();
  for (const stage of STAGE_IDS) {
    const run = s.stages[stage];
    if (run.data === null) continue;
    // A challenge only runs on a long enough answer: a shorter one has been edited since.
    if (stage === "challenge" && (isStale(s, stage) || s.challengeAnswer.trim().length < MIN_CHALLENGE_CHARS)) {
      stale.set(stage, STALE_NOTES.answer);
    } else if (isStale(s, stage)) stale.set(stage, STALE_NOTES.inputs);
    else if (run.status !== "done") stale.set(stage, STALE_NOTES.rerun);
  }
  return stale;
}

export function formatDate(date: Date) {
  return date.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
}

export function sessionToMarkdown(s: Session, now = new Date()): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines, "");
  const list = (title: string, items: string[]) => {
    if (items.length) push(title, "", ...items.map((item) => `- ${item}`));
  };

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

  const stale = staleSections(s);
  const heading = (title: string, stage: StageId) => {
    const note = stale.get(stage);
    return note ? `${title}\n\n**⚠️ Section à mettre à jour :** ${note}\n` : title;
  };

  const brief =
    classification && mapping && questions
      ? buildCaseBrief({
          caseText: s.caseText,
          classification,
          mapping,
          questions,
          clarifications: clarificationList(s),
          clientNotes: s.clientNotes,
        })
      : null;
  const sourceOf = (basis: string[]) => (brief ? SOURCE_LABELS[sourceOfBasis(basis, brief)].toLowerCase() : "");

  push(
    `# ${mapping?.reformulation ?? "Business case"}`,
    "",
    `_Consultant Dots · ${formatDate(now)}${classification ? ` · ${domainLabel(classification.primaryDomain)}` : ""}_`,
  );
  push("## Énoncé", "", quote(s.caseText));

  if (classification) {
    const secondary = classification.secondaryDomains.map(domainLabel).join(", ");
    push(
      heading("## Type de case", "classify"),
      "",
      `**${domainLabel(classification.primaryDomain)}** (${Math.round(classification.confidence)} %)${secondary ? ` · secondaires : ${secondary}` : ""}`,
      "",
      classification.rationale,
    );
  }

  if (mapping) {
    push(heading("## Cadrage", "frame"), "", `**Le problème en une phrase :** ${mapping.reformulation}`);
    if (mapping.premiseChallenge) push(`**Recadrage :** ${mapping.premiseChallenge}`);
    const tag = (source: "case" | "assumption") => (source === "case" ? "fait" : "hypothèse");
    list("### Objectifs business", mapping.businessObjectives.map((o) => `${o.text} _(${tag(o.source)})_`));
    list("### Pain points", mapping.painPoints);
    list(
      "### Contraintes",
      mapping.constraints.map((c) => `**${CONSTRAINT_LABELS[c.type]}** — ${c.text} _(${tag(c.source)})_`),
    );
    list("### Parties prenantes", mapping.stakeholders.map((p) => `**${p.name}** — ${p.role} _(${tag(p.source)})_`));
    list("### Faits (énoncé)", mapping.facts.map((f) => `**${f.id}** — ${f.text} (« ${f.evidence} »)`));
    list(
      "### Hypothèses",
      (brief?.assumptions ?? mapping.assumptions).map((a) => `**${a.id}** — ${a.text} _(base : ${a.basis})_`),
    );
  }

  if (questions) {
    push(heading("## Questions de clarification", "questions"));
    const retained = new Map(brief?.clarifications.map((c) => [c.id, c]));
    for (const q of questions.questions) {
      const c = retained.get(q.id);
      push(
        `**${q.id} — ${q.question}**`,
        "",
        `- Pourquoi : ${q.whyItMatters}`,
        `- Décision impactée : ${q.decisionImpact}`,
        c?.source === "client"
          ? `- **Réponse du client :** ${c.answer}`
          : `- Hypothèse de travail${s.gatePassed ? "" : " (par défaut)"} : ${q.defaultAssumption}`,
      );
    }
    list("### Autres informations du client", brief?.clientNotes.map((n) => `**${n.id}** — ${n.text}`) ?? []);
  }

  if (diagnostic) {
    push(heading("## Diagnostic", "diagnose"), "### Arbre de raisonnement");
    diagnostic.framework.forEach((step, i) => {
      push(
        `${i + 1}. **${step.step}** _(${BACKBONE_LABELS[step.backbone]})_ — ${step.focus}`,
        ...step.keyQuestions.map((q) => `   - ${q}`),
      );
    });
    list(
      "### Constats",
      diagnostic.findings.map(
        (f) => `**${f.dimension}** — ${f.finding} _(${sourceOf(f.basis)}${f.basis.length ? ` : ${f.basis.join(", ")}` : ""})_`,
      ),
    );
    if (diagnostic.rootCauses.length) {
      push("### Causes racines", "", ...diagnostic.rootCauses.map((c, i) => `${i + 1}. ${c}`));
    }
    push(`**Insight clé :** ${diagnostic.keyInsight}`);
  }

  if (current) {
    push(heading("## Schéma de l'existant", "currentState"), "```mermaid", toMermaid(current.diagram), "```");
    list("### Goulots d'étranglement", current.bottlenecks);
  }

  if (options) {
    push(heading("## Options", "options"));
    for (const option of options.options) {
      const recommended = options.recommendation.optionId === option.id;
      push(
        `### ${option.name}${recommended ? " — recommandée" : ""}`,
        "",
        option.description,
        "",
        ...option.advantages.map((a) => `- **+** ${a}`),
        ...option.drawbacks.map((d) => `- **−** ${d}`),
        ...(option.conditions.length ? ["", `_Si : ${option.conditions.join(" · ")}_`] : []),
      );
    }
    const comparison = options.comparison ?? EMPTY_COMPARISON;
    if (comparison.constraints.length || comparison.criteria.length) {
      const columns = options.options;
      const byOption = <T extends { optionId: string }>(items: T[], id: string) => items.find((item) => item.optionId === id);
      push(
        "### Comparaison des options",
        "",
        `| | ${columns.map((o) => cell(`${o.id} · ${o.name}${o.id === options.recommendation.optionId ? " ★" : ""}`)).join(" | ")} |`,
        `|---|${columns.map(() => "---").join("|")}|`,
        ...comparison.constraints.map((c) => {
          const basis = c.basis.length ? ` _(${sourceOf(c.basis)} : ${c.basis.join(", ")})_` : "";
          const fits = columns.map((o) => {
            const fit = byOption(c.fits, o.id);
            return fit ? cell(`${FIT_MARKS[fit.fit]} ${fit.note}`) : "—";
          });
          return `| **Contrainte** ${cell(c.label)}${basis} | ${fits.join(" | ")} |`;
        }),
        ...comparison.criteria.map((c) => {
          const scores = columns.map((o) => {
            const score = byOption(c.scores, o.id);
            return score ? `${score.score}/5` : "—";
          });
          return `| **Critère** ${cell(c.label)} | ${scores.join(" | ")} |`;
        }),
        "",
        "_✓ respectée · ⚠ sous condition · ✗ bloquante · critères notés de 1 à 5, 5 = meilleur_",
      );
    }

    push(
      "### Recommandation",
      "",
      `**${options.recommendation.statement}**`,
      "",
      options.recommendation.rationale,
      ...(options.recommendation.dependsOn.length ? ["", `_Dépend de : ${options.recommendation.dependsOn.join(", ")}_`] : []),
    );

    const pivots = options.recommendation.pivots ?? [];
    if (pivots.length) {
      const names = new Map(options.options.map((o) => [o.id, o.name]));
      const recoId = options.recommendation.optionId;
      push("### Ce qui ferait changer la recommandation");
      const code = pivotsToMermaid(options);
      if (code) push("```mermaid", code, "```");
      push(
        ...pivots.map((p) => {
          const alternative =
            p.thenOptionId && names.has(p.thenOptionId) ? `${p.thenOptionId} · ${names.get(p.thenOptionId)}` : `${recoId ?? "recommandation"} adaptée`;
          return `- **${p.basis ? `${p.basis} — ` : ""}${p.question}** Aujourd'hui : ${p.assumed}. Sinon (${p.ifInstead}) → **${alternative}** : ${p.consequence}`;
        }),
      );
    }

    const weights = s.matrix.weights;
    const rows = [...options.initiatives].sort((a, b) => weightedScore(b, weights) - weightedScore(a, weights));
    push(
      heading("## Priorisation", "options"),
      "",
      "| Initiative | Valeur | Faisabilité | Risque | Délai | Réutilisation | Score | Verdict |",
      "|---|---:|---:|---:|---:|---:|---:|---|",
      ...rows.map(
        (i) =>
          `| ${cell(i.name)} | ${CRITERIA.map((c) => i[c]).join(" | ")} | ${weightedScore(i, weights)} | ${VERDICT_LABELS[i.verdict]} |`,
      ),
      "",
      `_${formulaLabel(weights)} · risque : 5 = élevé${matrixEdited(s) ? " · priorisation ajustée par moi" : ""}_`,
    );
    if (rows.length) push("```mermaid", priorityToMermaid(rows), "```");
    list(
      heading("## Pièges à éviter", "options"),
      options.traps.map((t) => `**${t.reflex} — ${REFLEXES[t.reflex].titleFr}** « ${REFLEXES[t.reflex].flagFr} » ${t.whyHere}`),
    );
  }

  if (target) {
    push(heading("## Cible", "target"));
    list("### Principes", target.principles);
    push("```mermaid", toMermaid(target.diagram), "```");
    list("### Avant → après", target.keyChanges.map((c) => `${c.from} → **${c.to}**`));
    list("### Modèle opérationnel", target.operatingModel);
  }

  if (roadmap) {
    push(heading("## Roadmap", "roadmap"));
    for (const phase of roadmap.phases) {
      push(
        `### ${phase.name} (${phase.timing})`,
        "",
        `**Objectif :** ${phase.objective}`,
        "",
        `- **Actions :** ${phase.actions.join(" ; ")}`,
        `- **Livrables :** ${phase.deliverables.join(" ; ")}`,
        `- **Décisions :** ${phase.decisions.join(" ; ")}`,
        `- **Dépendances :** ${phase.dependencies.join(" ; ")}`,
        `- **KPIs :** ${phase.kpis.join(" ; ")}`,
      );
    }
    push(
      `### Pilote : ${roadmap.pilot.initiative}`,
      "",
      `**Périmètre :** ${roadmap.pilot.scope}`,
      "",
      roadmap.pilot.why,
      "",
      ...roadmap.pilot.successCriteria.map((c) => `- ✓ ${c}`),
      "",
      `_Fondations réutilisables : ${roadmap.pilot.reusableFoundations.join(" · ")}_`,
    );
    push(
      "### KPIs",
      "",
      "| Type | KPI | Baseline | Cible |",
      "|---|---|---|---|",
      ...roadmap.kpis.map((k) => `| ${KPI_TYPE_LABELS[k.type]} | ${cell(k.name)} | ${cell(k.baseline)} | ${cell(k.target)} |`),
    );
    push(
      "### Risques",
      "",
      "| Risque | Impact | Parade |",
      "|---|---|---|",
      ...roadmap.risks.map((r) => `| ${cell(r.risk)} | ${cell(r.impact)} | ${cell(r.mitigation)} |`),
    );
  }

  if (oral) {
    push(heading(`## Restitution orale (${oral.duration})`, "oral"), "", quote(`« ${oral.opening} »`));
    oral.sections.forEach((section, i) => {
      push(`### ${i + 1}. ${section.title}`, "", ...section.bullets.map((b) => `- **${b.point}** — ${b.detail}`));
    });
    push(quote(`« ${oral.closing} »`));
    list(
      "### Les points qui font la différence",
      oral.differentiators.map((d) => `**${d.point}** — « ${d.howToSayIt} »`),
    );
  }

  const notes = ZONE_KEYS.filter((zone) => s.notes[zone]?.trim());
  if (notes.length) {
    push("## Mes notes");
    for (const zone of notes) push(`### ${ZONE_TITLES[zone]}`, "", s.notes[zone]!.trim());
  }

  if (challenge && s.challengeAnswer.trim()) {
    push(
      heading("## Challenge de ma réponse", "challenge"),
      "### Ma réponse",
      "",
      quote(s.challengeAnswer),
      "",
      `**Niveau : ${CHALLENGE_LEVEL_LABELS[challenge.level]}** — ${challenge.verdict}`,
    );
    if (challenge.flags.length) {
      push("### Points à corriger");
      for (const flag of challenge.flags) {
        push(
          `- **${flag.reflex} · ${REFLEXES[flag.reflex].titleFr}** (${SEVERITY_LABELS[flag.severity].toLowerCase()}) — ${flag.issue}`,
          ...(flag.quote ? [`  - Dans ma réponse : « ${flag.quote} »`] : []),
          `  - L'interviewer : « ${flag.interviewerQuestion} »`,
          `  - À dire plutôt : ${flag.fix}`,
        );
      }
    }
    list("### Points forts", challenge.strengths);
    list("### Ce qui manque", challenge.missing);
    list("### Prochaine version", challenge.nextVersion);
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
