import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/** One folder per case: `<date>_<type>_<id>/` with the full session and a readable Markdown copy. */
export const casesRoot = () => process.env.CONSULTANT_DOTS_CASES_DIR?.trim() || path.join(/*turbopackIgnore: true*/ process.cwd(), "cases");
const TRASH = "_corbeille";

export const isCaseId = (id: string) => /^[a-z0-9]{8}$/.test(id);

export type SavedCaseSummary = {
  id: string;
  folder: string;
  title: string;
  domain: string | null;
  updatedAt: string;
  stagesDone: number;
};

const slugify = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "case";

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;

function folders(): string[] {
  const root = casesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== TRASH)
    .map((d) => d.name);
}

const folderOf = (id: string) => folders().find((name) => name.endsWith(`_${id}`)) ?? null;

function trashed(id: string) {
  const trash = path.join(casesRoot(), TRASH);
  return existsSync(trash) && readdirSync(trash).some((name) => name.endsWith(`_${id}`));
}

function writeAtomic(file: string, content: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

/** session.json carries the number of saves made with revisions; files written before that count as 0. */
const asRevision = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);

/** Besides the revision, session.json names the save that wrote it (`writeId`), absent from older files. */
function readSession(folder: string) {
  const { revision, writeId, ...session } = JSON.parse(readFileSync(path.join(casesRoot(), folder, "session.json"), "utf8"));
  return { session: session as Record<string, unknown>, revision: asRevision(revision), writeId: typeof writeId === "string" ? writeId : null };
}

function storedSession(folder: string) {
  try {
    return readSession(folder);
  } catch {
    return null; // missing or hand-edited file
  }
}

export type SaveResult = { ok: true; folder: string; revision: number } | { ok: false; reason: "conflict" | "gone" };

export type SaveInput = {
  session: object;
  markdown: string;
  label: string;
  /** The revision the tab last loaded or saved, none for a case it never saved. */
  baseRevision?: number | null;
  writeId?: string;
  /** The tab's earlier saves whose answer never came back (a reload, a dropped connection): one may be on disk. */
  unconfirmed?: string[];
};

/**
 * Saves only on top of what the tab last saw: the revision it last loaded or saved, or one of its own saves whose answer
 * was lost. A stale tab can neither overwrite a newer save nor bring back a case put in the trash.
 */
export function saveCase(id: string, input: SaveInput): SaveResult {
  const root = casesRoot();
  const existing = folderOf(id);
  const base = input.baseRevision ?? 0;
  if (!existing && (base > 0 || trashed(id))) return { ok: false, reason: "gone" };
  const stored = existing ? storedSession(existing) : null;
  // Already on disk (a save applied whose answer was lost, or a tab with nothing new): nothing to write or overwrite.
  if (existing && stored && isDeepStrictEqual(stored.session, input.session)) {
    return { ok: true, folder: existing, revision: stored.revision };
  }
  const current = stored?.revision ?? 0;
  const ownSave = stored?.writeId != null && (input.unconfirmed ?? []).includes(stored.writeId);
  if (base !== current && !ownSave) return { ok: false, reason: "conflict" };

  mkdirSync(root, { recursive: true });
  const date = existing ? existing.slice(0, 15) : stamp(new Date());
  const wanted = `${date}_${slugify(input.label)}_${id}`;
  if (existing && existing !== wanted) renameSync(path.join(root, existing), path.join(root, wanted));
  const dir = path.join(root, wanted);
  mkdirSync(dir, { recursive: true });
  const revision = current + 1;
  writeAtomic(path.join(dir, "analyse.md"), input.markdown);
  // Last, so the revision only moves on once both files are written.
  writeAtomic(path.join(dir, "session.json"), `${JSON.stringify({ ...input.session, revision, writeId: input.writeId }, null, 2)}\n`);
  return { ok: true, folder: wanted, revision };
}

export function loadCase(id: string): { session: Record<string, unknown>; revision: number } | null {
  const folder = folderOf(id);
  if (!folder) return null;
  const { session, revision } = readSession(folder);
  return { session, revision };
}

/** Deleting moves the folder to `_corbeille` rather than destroying the user's work. */
export function trashCase(id: string) {
  const folder = folderOf(id);
  if (!folder) return false;
  const trash = path.join(casesRoot(), TRASH);
  mkdirSync(trash, { recursive: true });
  renameSync(path.join(casesRoot(), folder), path.join(trash, folder));
  return true;
}

type StoredSession = {
  caseText?: string;
  stages?: Record<string, { status?: string; data?: { reformulation?: string; primaryDomain?: string } | null }>;
};

export function listCases(): SavedCaseSummary[] {
  const out: SavedCaseSummary[] = [];
  for (const folder of folders()) {
    const id = folder.slice(folder.lastIndexOf("_") + 1);
    const file = path.join(casesRoot(), folder, "session.json");
    if (!isCaseId(id) || !existsSync(file)) continue;
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as StoredSession;
      const stages = s.stages ?? {};
      out.push({
        id,
        folder,
        title: stages.frame?.data?.reformulation ?? (s.caseText ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        domain: stages.classify?.data?.primaryDomain ?? null,
        updatedAt: statSync(file).mtime.toISOString(),
        stagesDone: Object.values(stages).filter((r) => r?.status === "done").length,
      });
    } catch {
      // A half-written or hand-edited file: skip it rather than break the list.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
