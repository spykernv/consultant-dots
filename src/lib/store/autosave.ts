"use client";

import { create } from "zustand";
import { domainLabel } from "@/lib/domain/domains";
import { sessionToMarkdown } from "@/lib/export/markdown";
import type { Session } from "./machine";
import { useSession } from "./session-store";

export type SaveState = {
  /** `conflict`: another tab saved the case since; `gone`: it was deleted. This tab no longer writes to it. */
  status: "idle" | "saving" | "saved" | "error" | "conflict" | "gone";
  folder: string | null;
  at: number | null;
};

export const useSaveState = create<SaveState>()(() => ({ status: "idle", folder: null, at: null }));

const DEBOUNCE_MS = 1200;
const RETRY_MS = 5000;
/** A request allowed to outlive the page is capped at 64 KiB; past that, only the beforeunload prompt protects. */
const KEEPALIVE_MAX_BYTES = 60_000;
const REVISION_KEY = "consultant-dots-revision:";
const UNCONFIRMED_KEY = "consultant-dots-unconfirmed:";
const MAX_UNCONFIRMED = 10;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastSaved: { id: string; json: string } | null = null;
let inFlight: Promise<boolean> | null = null;
let blocked: { id: string; status: "conflict" | "gone" } | null = null;
let edited = false;
const revisions = new Map<string, number>();

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const label = (s: Session) => (s.stages.classify.data ? domainLabel(s.stages.classify.data.primaryDomain) : "case");

/** The revision on disk this tab's copy builds on (none before the first save), kept per tab like the session. */
function baseRevision(id: string): number | null {
  const known = revisions.get(id);
  if (known !== undefined) return known;
  try {
    const stored = sessionStorage.getItem(REVISION_KEY + id);
    return stored !== null && /^\d+$/.test(stored) ? Number(stored) : null;
  } catch {
    return null;
  }
}

function rememberRevision(id: string, revision: number) {
  revisions.set(id, revision);
  try {
    sessionStorage.setItem(REVISION_KEY + id, String(revision));
  } catch {
    // Storage unavailable: the module copy still holds it until a reload.
  }
}

/** This tab's saves of the case still unanswered, e.g. sent by the page just reloaded: the server accepts building on them. */
function unconfirmed(id: string): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(UNCONFIRMED_KEY + id) ?? "[]");
    return Array.isArray(stored) ? stored.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

function setUnconfirmed(id: string, writeIds: string[]) {
  try {
    if (writeIds.length) sessionStorage.setItem(UNCONFIRMED_KEY + id, JSON.stringify(writeIds.slice(-MAX_UNCONFIRMED)));
    else sessionStorage.removeItem(UNCONFIRMED_KEY + id);
  } catch {
    // Storage unavailable: a save whose answer is lost then counts as another tab's.
  }
}

async function put(id: string, s: Session, json: string): Promise<boolean> {
  useSaveState.setState({ status: "saving" });
  const earlier = unconfirmed(id);
  const writeId = crypto.randomUUID();
  // Noted before sending: if the page is gone before the answer, the reloaded tab may still build on this save.
  setUnconfirmed(id, [...earlier, writeId]);
  try {
    const body = JSON.stringify({
      session: s,
      markdown: sessionToMarkdown(s),
      label: label(s),
      baseRevision: baseRevision(id),
      writeId,
      unconfirmed: earlier,
    });
    const res = await fetch(`/api/cases/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: new Blob([body]).size <= KEEPALIVE_MAX_BYTES,
    });
    if (res.status === 409 || res.status === 410) {
      // Saving anyway would overwrite the other tab's work or bring a deleted case back.
      blocked = { id, status: res.status === 409 ? "conflict" : "gone" };
      useSaveState.setState({ status: blocked.status });
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { folder, revision } = (await res.json()) as { folder: string; revision: number };
    rememberRevision(id, revision);
    setUnconfirmed(id, []);
    lastSaved = { id, json };
    useSaveState.setState({ status: "saved", folder, at: Date.now() });
    return true;
  } catch {
    useSaveState.setState({ status: "error" });
    // The server may just be restarting: try again a bit later.
    schedule(RETRY_MS);
    return false;
  }
}

/** Resolves to whether the current session is on disk once this save is done. */
async function save(): Promise<boolean> {
  const s = useSession.getState();
  // Only real cases are kept: the demo replays recorded outputs.
  if (!s.started || s.mock) return false;
  if (!s.savedId) {
    useSession.setState({ savedId: newId() });
    return save();
  }
  const id = s.savedId;
  if (blocked?.id === id) {
    useSaveState.setState({ status: blocked.status });
    return false;
  }
  if (inFlight) {
    await inFlight;
    return save();
  }
  const json = JSON.stringify(s);
  if (lastSaved?.id === id && lastSaved.json === json) return true;
  inFlight = put(id, s, json).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function schedule(delay = DEBOUNCE_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void save(), delay);
}

/** False only when the server says the case is gone: an unreachable server does not undo the last save. */
async function stillOnDisk(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/cases/${id}`, { method: "HEAD", cache: "no-store" });
    if (res.status !== 404) return true;
  } catch {
    return true;
  }
  blocked = { id, status: "gone" };
  useSaveState.setState({ status: "gone" });
  return false;
}

/**
 * Saves the current session now rather than after the debounce, once any save under way is done. Resolves to whether
 * it is in cases/ then: with nothing new to write, the server is asked, as another tab may have put the case in the trash.
 */
export async function flushAutosave(): Promise<boolean> {
  if (timer) clearTimeout(timer);
  timer = null;
  const before = lastSaved;
  if (!(await save())) return false;
  return lastSaved !== before || !lastSaved || stillOnDisk(lastSaved.id);
}

/** Right after actions.openSaved: the next save builds on the revision read from disk, and waits for a change. */
export function openedFromDisk(id: string, revision: number, folder: string) {
  rememberRevision(id, revision);
  setUnconfirmed(id, []);
  if (blocked?.id === id) blocked = null;
  lastSaved = { id, json: JSON.stringify(useSession.getState()) };
  useSaveState.setState({ status: "saved", folder, at: Date.now() });
}

/** Keeps this tab's version of a case changed or deleted elsewhere, as a new saved case. */
export function keepCopy() {
  useSession.setState({ savedId: newId() }); // the subscription schedules its first save
}

function onChange(s: Session, prev: Session) {
  edited = true;
  // A new, reopened or copied case: the indicator no longer speaks about the previous one.
  if (s.savedId !== prev.savedId) useSaveState.setState({ status: "idle", folder: null, at: null });
  schedule();
}

/** Edits of a real case made in this page and not on disk yet (a restored tab is not nagged before it changes). */
function unsaved() {
  const s = useSession.getState();
  if (!edited || !s.started || s.mock) return false;
  return lastSaved?.id !== s.savedId || lastSaved.json !== JSON.stringify(s);
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!unsaved()) return;
  void flushAutosave(); // finishes even if the user leaves, when the case is small enough for keepalive
  event.preventDefault();
  event.returnValue = "";
}

/** Saves every real case to cases/<folder>/ a moment after each change. Returns the unsubscribe. */
export function startAutosave() {
  const unsubscribe = useSession.subscribe(onChange);
  window.addEventListener("beforeunload", onBeforeUnload);
  schedule();
  return () => {
    unsubscribe();
    window.removeEventListener("beforeunload", onBeforeUnload);
    if (timer) clearTimeout(timer);
  };
}
