// @vitest-environment jsdom
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/cases/[id]/route";
import { loadCase } from "@/lib/server/case-store";
import { initialSession, type Session } from "@/lib/store/machine";

type Autosave = typeof import("@/lib/store/autosave");
type Store = typeof import("@/lib/store/session-store");

/** The cases API as the server answers it: a save must build on the revision on disk. */
function fakeServer() {
  const server = {
    revision: 0,
    status: null as number | null,
    down: false,
    gate: null as Promise<void> | null,
    trashed: false,
    fetch: vi.fn(async (_url: string, init: RequestInit) => {
      if (server.gate) await server.gate;
      if (server.down) throw new TypeError("Failed to fetch");
      if (init.method === "HEAD") return new Response(null, { status: server.trashed ? 404 : 200 });
      if (server.status) return Response.json({ error: "refusé" }, { status: server.status });
      const { baseRevision } = JSON.parse(String(init.body)) as { baseRevision: number | null };
      if ((baseRevision ?? 0) !== server.revision) return Response.json({ error: "conflit" }, { status: 409 });
      server.revision += 1;
      return Response.json({ folder: "2026-10-01_1200_case_ab12cd34", revision: server.revision });
    }),
  };
  return server;
}

const realCase = (patch: Partial<Session> = {}): Session => ({ ...initialSession(), started: true, caseText: "Un case.", ...patch });

/** Closing or reloading the page: true when the page asks first. */
function leave() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("autosave", () => {
  let autosave: Autosave;
  let useSession: Store["useSession"];
  let server: ReturnType<typeof fakeServer>;
  let stop: (() => void) | null;

  const puts = () =>
    server.fetch.mock.calls
      .filter(([, init]) => init.method === "PUT")
      .map(([url, init]) => ({ url, ...(JSON.parse(String(init.body)) as { session: Session; baseRevision: number | null }) }));
  const status = () => autosave.useSaveState.getState().status;
  const debounce = () => vi.advanceTimersByTimeAsync(1200);
  /** Opens the tab on a session, as a rehydrated tab would, then starts saving. */
  const startWith = (session: Session) => {
    useSession.setState(session, true);
    stop = autosave.startAutosave();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    sessionStorage.clear();
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetch);
    autosave = await import("@/lib/store/autosave");
    ({ useSession } = await import("@/lib/store/session-store"));
    stop = null;
  });

  afterEach(() => {
    stop?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("gives a new case an id, saves it without base revision, then builds on the revision returned", async () => {
    startWith(realCase());
    await debounce();
    const id = useSession.getState().savedId;
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(puts()).toMatchObject([{ url: `/api/cases/${id}`, baseRevision: null }]);
    expect(sessionStorage.getItem(`consultant-dots-revision:${id}`)).toBe("1");

    useSession.setState({ clientNotes: "Budget serré" });
    await debounce();
    expect(puts()[1]).toMatchObject({ baseRevision: 1, session: { clientNotes: "Budget serré" } });
    expect(status()).toBe("saved");
  });

  it("writes the last edit at once on flush, so closing the case right after typing loses nothing", async () => {
    startWith(realCase({ savedId: "ab12cd34" }));
    await debounce();
    useSession.setState({ notes: { case: "Dernière note" } });

    await expect(autosave.flushAutosave()).resolves.toBe(true);
    expect(puts()).toHaveLength(2);
    expect(puts()[1].session.notes).toEqual({ case: "Dernière note" });

    useSession.setState(initialSession(1), true); // what "Fermer le case" does next
    await vi.advanceTimersByTimeAsync(10_000);
    expect(puts()).toHaveLength(2);
  });

  it("lets a save under way finish before flushing what changed meanwhile", async () => {
    let release = () => {};
    server.gate = new Promise((resolve) => (release = resolve));
    startWith(realCase({ savedId: "ab12cd34" }));
    await debounce();
    useSession.setState({ clientNotes: "Pendant l'enregistrement" });

    const flushed = autosave.flushAutosave();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    server.gate = null;
    release();
    await expect(flushed).resolves.toBe(true);
    expect(puts()).toMatchObject([{ baseRevision: null }, { baseRevision: 1, session: { clientNotes: "Pendant l'enregistrement" } }]);
  });

  it("says a failed save is not saved, then retries", async () => {
    server.down = true;
    startWith(realCase({ savedId: "ab12cd34" }));
    await expect(autosave.flushAutosave()).resolves.toBe(false);
    expect(status()).toBe("error");

    server.down = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(status()).toBe("saved");
    await expect(autosave.flushAutosave()).resolves.toBe(true);
  });

  it("does not call a case put in the trash from another tab saved, even with nothing left to write", async () => {
    startWith(realCase({ savedId: "ab12cd34" }));
    await debounce();
    server.down = true; // no answer proves nothing: the last save stands
    await expect(autosave.flushAutosave()).resolves.toBe(true);

    server.down = false;
    server.trashed = true;
    await expect(autosave.flushAutosave()).resolves.toBe(false);
    expect(status()).toBe("gone");
    expect(puts()).toHaveLength(1);
  });

  it("stops writing to a case another tab saved since, and can keep this version as a copy", async () => {
    server.revision = 3; // the other tab saved on top of revision 2
    sessionStorage.setItem("consultant-dots-revision:ab12cd34", "2");
    startWith(realCase({ savedId: "ab12cd34" }));
    await debounce();
    expect(puts()).toMatchObject([{ url: "/api/cases/ab12cd34", baseRevision: 2 }]);
    expect(status()).toBe("conflict");

    useSession.setState({ clientNotes: "Encore une note" });
    await debounce();
    await expect(autosave.flushAutosave()).resolves.toBe(false);
    expect(puts()).toHaveLength(1);
    expect(status()).toBe("conflict");

    server.revision = 0;
    autosave.keepCopy();
    await debounce();
    const copy = useSession.getState().savedId;
    expect(copy).not.toBe("ab12cd34");
    expect(puts()[1]).toMatchObject({ url: `/api/cases/${copy}`, baseRevision: null, session: { clientNotes: "Encore une note" } });
    expect(status()).toBe("saved");
  });

  it("does not bring back a case deleted meanwhile", async () => {
    server.status = 410;
    startWith(realCase({ savedId: "ab12cd34" }));
    await debounce();
    expect(status()).toBe("gone");
    useSession.setState({ clientNotes: "x" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(puts()).toHaveLength(1);
  });

  it("builds on the revision of a case opened from the list, and writes nothing before it changes", async () => {
    startWith(realCase({ savedId: "ab12cd34" }));
    server.status = 409;
    await debounce();
    expect(status()).toBe("conflict");

    // Reopened from the home list: the GET said revision 4.
    server.status = null;
    server.revision = 4;
    useSession.setState(realCase({ savedId: "ab12cd34", caseText: "Version du disque" }), true);
    autosave.openedFromDisk("ab12cd34", 4, "2026-10-01_1200_case_ab12cd34");
    await debounce();
    expect(puts()).toHaveLength(1);
    expect(status()).toBe("saved");

    useSession.setState({ clientNotes: "Suite" });
    await debounce();
    expect(puts()[1]).toMatchObject({ baseRevision: 4, session: { caseText: "Version du disque", clientNotes: "Suite" } });
  });

  it("never saves the demo", async () => {
    startWith(realCase({ mock: true }));
    useSession.setState({ clientNotes: "x" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(autosave.flushAutosave()).resolves.toBe(false);
    expect(server.fetch).not.toHaveBeenCalled();
    expect(useSession.getState().savedId).toBeNull();
  });

  it("asks before leaving the page only while an edit is not on disk", async () => {
    startWith(realCase({ savedId: "ab12cd34" }));
    expect(leave()).toBe(false); // a restored tab is not nagged

    useSession.setState({ clientNotes: "Tapé à l'instant" });
    expect(leave()).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // the prompt also started the save
    expect(puts()).toMatchObject([{ session: { clientNotes: "Tapé à l'instant" } }]);
    expect(leave()).toBe(false);

    server.down = true;
    useSession.setState({ clientNotes: "Serveur arrêté" });
    await debounce();
    expect(status()).toBe("error");
    expect(leave()).toBe(true);
  });
});

describe("autosave against the cases API", () => {
  let dir: string;
  let autosave: Autosave;
  let useSession: Store["useSession"];
  let stop: (() => void) | null;
  /** The server still does the work, but its answers never reach the page: it is being reloaded. */
  let cutOff: boolean;

  const api = async (url: string, init: RequestInit) => {
    const request = new Request(`http://127.0.0.1:3000${url}`, {
      method: init.method,
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: init.body,
    });
    const ctx = { params: Promise.resolve({ id: url.slice(url.lastIndexOf("/") + 1) }) };
    const res = init.method === "PUT" ? await PUT(request, ctx) : await GET(request, ctx);
    return cutOff ? new Promise<Response>(() => {}) : res;
  };

  /** A new page on this tab's sessionStorage, as F5 or reopening the closed tab gives. */
  const load = async () => {
    stop?.();
    vi.resetModules();
    autosave = await import("@/lib/store/autosave");
    ({ useSession } = await import("@/lib/store/session-store"));
    await useSession.persist.rehydrate();
    cutOff = false;
    stop = autosave.startAutosave();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(os.tmpdir(), "consultant-dots-cases-"));
    process.env.CONSULTANT_DOTS_CASES_DIR = dir;
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(api));
    stop = null;
    cutOff = false;
  });

  afterEach(() => {
    stop?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.CONSULTANT_DOTS_CASES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const fresh = initialSession().stages;
  it.each([
    ["as it was sent", fresh],
    ["with a stage cut short by the reload", { ...fresh, frame: { ...fresh.frame, status: "running" as const } }],
  ])("keeps saving after a reload that cut off the answer to its last save, the session coming back %s", async (_, stages) => {
    await load();
    useSession.setState(realCase({ savedId: "ab12cd34", stages }), true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(loadCase("ab12cd34")?.revision).toBe(1);

    useSession.setState({ clientNotes: "Dernière note" });
    cutOff = true;
    expect(leave()).toBe(true); // the prompt sends the save, which lands after the page is gone
    await vi.waitFor(() => expect(loadCase("ab12cd34")).toMatchObject({ revision: 2, session: { clientNotes: "Dernière note" } }));

    await load();
    await vi.advanceTimersByTimeAsync(1200);
    expect(autosave.useSaveState.getState().status).toBe("saved");
    useSession.setState({ clientNotes: "Après rechargement" });
    await vi.advanceTimersByTimeAsync(1200);
    expect(autosave.useSaveState.getState().status).toBe("saved");
    expect(loadCase("ab12cd34")?.session).toMatchObject({ clientNotes: "Après rechargement", stages: { frame: { status: stages.frame.status === "running" ? "interrupted" : "idle" } } });
  });
});
