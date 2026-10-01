import { CRITERIA } from "@/lib/domain/scoring";
import type { Initiative, Verdict } from "@/lib/schemas/options";
import { ADDED_BY_USER } from "./machine";

const NOTE_PREFIX = "Priorisation : ";

/** Initiatives are matched by name the way a reader would: case, accents, punctuation and spacing aside. */
const nameKey = (name: string) =>
  name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);

const pilotOf = (initiatives: Initiative[]) => initiatives.find((i) => i.verdict === "pilot")?.name ?? null;

type Choices = { pilot: string | null; added: Initiative[] };

/** What the user decided in the matrix: a pilot other than the generated one, and the rows they added. */
function choicesOf(working: Initiative[], generated: Initiative[]): Choices {
  const chosen = pilotOf(working);
  return {
    pilot: chosen !== null && chosen !== pilotOf(generated) ? chosen : null,
    added: working.filter((i) => i.comment === ADDED_BY_USER),
  };
}

const withVerdict = (i: Initiative, verdict: Verdict): Initiative => (i.verdict === verdict ? i : { ...i, verdict });

/** `initiatives` plus the added rows that are missing, with a single pilot: the user's when it exists. */
function applyChoices(initiatives: Initiative[], choices: Choices): Initiative[] {
  const added = choices.added.filter((row) => !initiatives.some((i) => sameName(i.name, row.name)));
  const rows = [...initiatives, ...added];
  const { pilot: name } = choices;
  const chosen = name === null ? undefined : rows.find((i) => sameName(i.name, name));
  const pilot = chosen ?? rows.find((i) => i.verdict === "pilot");
  return rows.map((i) => (i === pilot ? withVerdict(i, "pilot") : i.verdict === "pilot" ? withVerdict(i, "next") : i));
}

const rowKey = (i: Initiative) => [nameKey(i.name), ...CRITERIA.map((c) => i[c]), i.verdict].join("|");

/** Whether the user changed scores or verdicts, or removed rows, in a way the new rows do not reflect. */
function editsLost(working: Initiative[], kept: Initiative[], rows: Initiative[]): boolean {
  const before = new Set(kept.map(rowKey));
  const after = new Set(rows.map(rowKey));
  const has = (list: Initiative[], row: Initiative) => list.some((i) => sameName(i.name, row.name));
  return (
    working.some((i) => !before.has(rowKey(i)) && !after.has(rowKey(i))) ||
    kept.some((i) => !has(working, i) && has(rows, i))
  );
}

export type MatrixCarry = { initiatives: Initiative[] | null; notes: string[] };

/**
 * The user's working copy once Options has been generated again. Their pilot (when an initiative of that name
 * still exists) and the initiatives they added are kept; scores and other verdicts follow the new result, which
 * the model re-scored. After an instruction (`steered`), the model saw their pilot and was told to keep it unless
 * asked otherwise, so its pilot stands. The notes say what could not be kept.
 */
export function carryMatrix(
  working: Initiative[] | null,
  previous: Initiative[],
  next: Initiative[],
  steered = false,
): MatrixCarry {
  if (!working) return { initiatives: null, notes: [] };
  const choices = choicesOf(working, previous);
  const rows = applyChoices(next, steered ? { ...choices, pilot: null } : choices);
  const notes: string[] = [];
  const chosen = choices.pilot;
  const proposed = pilotOf(rows);
  if (chosen && !rows.some((i) => sameName(i.name, chosen))) {
    notes.push(
      `${NOTE_PREFIX}ton pilote « ${chosen} » n'existe plus dans les nouvelles options, ` +
        (proposed ? `c'est « ${proposed} » qui est proposé.` : "aucun pilote n'est proposé.") +
        " Clique sur un verdict pour en choisir un autre.",
    );
  } else if (chosen && !(proposed && sameName(proposed, chosen))) {
    notes.push(
      `${NOTE_PREFIX}avec ta consigne, la nouvelle version ` +
        (proposed ? `propose « ${proposed} » comme pilote au lieu de « ${chosen} ».` : "ne propose plus de pilote.") +
        ` Pour revenir à ton choix, fais de « ${chosen} » le pilote dans le tableau ou le graphique.`,
    );
  }
  if (editsLost(working, applyChoices(previous, choices), rows)) {
    const other = choices.pilot || choices.added.length > 0 ? "autres " : "";
    notes.push(`${NOTE_PREFIX}la nouvelle version ne reprend pas tes ${other}ajustements (scores, verdicts, retraits).`);
  }
  const unchanged = rows.length === next.length && rows.every((row, i) => row === next[i]);
  return { initiatives: unchanged ? null : rows, notes };
}

/** The notes carryMatrix left on the options run, to show next to the matrix. */
export function matrixNotices(notes: string[]): string[] {
  return notes
    .filter((note) => note.startsWith(NOTE_PREFIX))
    .map((note) => note.charAt(NOTE_PREFIX.length).toUpperCase() + note.slice(NOTE_PREFIX.length + 1));
}

/** The run's notes without carryMatrix's, which no longer apply once the user has edited the new matrix. */
export function withoutMatrixNotices(notes: string[]): string[] {
  return notes.filter((note) => !note.startsWith(NOTE_PREFIX));
}

/** What a new Options run will keep of the user's matrix, said before they trigger it (after "Priorisation : "). */
export function matrixCarryHint(working: Initiative[] | null, generated: Initiative[], steered = false): string | null {
  if (!working) return null;
  const { pilot, added } = choicesOf(working, generated);
  const kept = [
    pilot && `ton pilote « ${pilot} » (${steered ? "sauf si ta consigne en fait proposer un autre" : "s'il existe encore"})`,
    added.length > 0 && (added.length > 1 ? "tes initiatives ajoutées" : "ton initiative ajoutée"),
  ].filter(Boolean);
  if (kept.length === 0) return "tes ajustements seront remplacés par les scores et verdicts de la nouvelle version.";
  return `tu gardes ${kept.join(" et ")} ; les scores et les ${pilot ? "autres " : ""}verdicts suivront la nouvelle version.`;
}
