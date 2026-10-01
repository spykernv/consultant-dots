import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCases, loadCase, saveCase, trashCase, type SaveResult } from "@/lib/server/case-store";
import { GET, PUT } from "@/app/api/cases/[id]/route";

const folderOf = (result: SaveResult) => {
  if (!result.ok) throw new Error(result.reason);
  return result.folder;
};

describe("case store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "consultant-dots-cases-"));
    process.env.CONSULTANT_DOTS_CASES_DIR = dir;
  });
  afterEach(() => {
    delete process.env.CONSULTANT_DOTS_CASES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const session = (reformulation: string | null) => ({
    caseText: "Un assureur veut de la GenAI.",
    stages: {
      classify: { status: "done", data: { primaryDomain: "genai_ai" } },
      frame: reformulation ? { status: "done", data: { reformulation } } : { status: "idle", data: null },
    },
  });

  it("keeps one folder per case with the session and a Markdown copy, renamed as the case gets its type", () => {
    const first = folderOf(saveCase("ab12cd34", { session: session(null), markdown: "# v1", label: "case" }));
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}_case_ab12cd34$/);
    const second = folderOf(
      saveCase("ab12cd34", { session: session("Aider les conseillers"), markdown: "# v2", label: "GenAI / IA", baseRevision: 1 }),
    );
    expect(second).toBe(`${first.slice(0, 15)}_genai-ia_ab12cd34`);
    expect(readdirSync(dir)).toEqual([second]);
    expect(readFileSync(path.join(dir, second, "analyse.md"), "utf8")).toBe("# v2");
    expect(loadCase("ab12cd34")).toMatchObject({ session: { caseText: "Un assureur veut de la GenAI." }, revision: 2 });
  });

  it("lists the saved cases with their title and moves deleted ones to the trash", () => {
    saveCase("ab12cd34", { session: session("Aider les conseillers"), markdown: "", label: "GenAI / IA" });
    expect(listCases()).toMatchObject([{ id: "ab12cd34", title: "Aider les conseillers", domain: "genai_ai", stagesDone: 2 }]);
    expect(trashCase("ab12cd34")).toBe(true);
    expect(listCases()).toEqual([]);
    expect(existsSync(path.join(dir, "_corbeille"))).toBe(true);
    expect(loadCase("ab12cd34")).toBeNull();
  });

  it("only saves on top of the revision the tab last saw, so a stale tab cannot overwrite a newer save", () => {
    expect(saveCase("ab12cd34", { session: session(null), markdown: "", label: "case" })).toMatchObject({ ok: true, revision: 1 });
    // Tab B saves on top of revision 1...
    const b = saveCase("ab12cd34", { session: session("Version de B"), markdown: "# B", label: "case", baseRevision: 1 });
    expect(b).toMatchObject({ ok: true, revision: 2 });
    // ...then tab A, still on revision 1 (or never told of one), is refused.
    expect(saveCase("ab12cd34", { session: session("Version de A"), markdown: "# A", label: "case", baseRevision: 1 })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(saveCase("ab12cd34", { session: session("Version de A"), markdown: "# A", label: "case" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(loadCase("ab12cd34")).toMatchObject({ session: { stages: { frame: { data: { reformulation: "Version de B" } } } }, revision: 2 });
    expect(readFileSync(path.join(dir, folderOf(b), "analyse.md"), "utf8")).toBe("# B");
  });

  it("still opens and saves a session.json written before revisions existed", () => {
    const legacy = path.join(dir, "2026-09-28_1924_genai-ia_ab12cd34");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "session.json"), JSON.stringify(session("Ancien case"), null, 2));
    expect(loadCase("ab12cd34")).toEqual({ session: session("Ancien case"), revision: 0 });
    expect(listCases()).toMatchObject([{ id: "ab12cd34", title: "Ancien case" }]);
    // A tab opened with the old code knows no revision; one opened from the list gets 0: both may save.
    expect(saveCase("ab12cd34", { session: session("Ancien case, complété"), markdown: "", label: "GenAI / IA" })).toMatchObject({
      ok: true,
      folder: "2026-09-28_1924_genai-ia_ab12cd34",
      revision: 1,
    });
    expect(loadCase("ab12cd34")?.session).toEqual(session("Ancien case, complété"));
  });

  it("accepts a save already on disk whatever revision the tab knew, without writing it again", () => {
    saveCase("ab12cd34", { session: session(null), markdown: "", label: "case" });
    const folder = folderOf(saveCase("ab12cd34", { session: session("Version 2"), markdown: "# v2", label: "case", baseRevision: 1 }));
    const file = path.join(dir, folder, "session.json");
    const written = readFileSync(file, "utf8");
    // The answer to the second save was lost: the tab still says revision 1, or none at all.
    for (const baseRevision of [1, null]) {
      expect(saveCase("ab12cd34", { session: session("Version 2"), markdown: "# autre date", label: "case", baseRevision })).toEqual({
        ok: true,
        folder,
        revision: 2,
      });
    }
    expect(readFileSync(file, "utf8")).toBe(written);
    expect(readFileSync(path.join(dir, folder, "analyse.md"), "utf8")).toBe("# v2");
  });

  it("lets a tab build on its own save whose answer never came, and nobody else", () => {
    // The page sent its first save, then was reloaded before the answer: it only knows it sent "w1".
    saveCase("ab12cd34", { session: session(null), markdown: "", label: "case", writeId: "w1" });
    expect(saveCase("ab12cd34", { session: session("Après rechargement"), markdown: "", label: "case", writeId: "w2", unconfirmed: ["w1"] })).toMatchObject({
      ok: true,
      revision: 2,
    });
    // Another tab still on revision 1, or a copy of the page made before "w1" was answered, is refused.
    expect(saveCase("ab12cd34", { session: session("Autre onglet"), markdown: "", label: "case", baseRevision: 1 })).toEqual({ ok: false, reason: "conflict" });
    expect(saveCase("ab12cd34", { session: session("Copie"), markdown: "", label: "case", unconfirmed: ["w1"] })).toEqual({ ok: false, reason: "conflict" });
    expect(loadCase("ab12cd34")).toEqual({ session: session("Après rechargement"), revision: 2 });
  });

  it("only moves the revision once both files are written, so the retry of a failed save goes through", () => {
    const folder = folderOf(saveCase("ab12cd34", { session: session(null), markdown: "# v1", label: "case" }));
    const markdown = path.join(dir, folder, "analyse.md");
    rmSync(markdown);
    mkdirSync(markdown); // analyse.md cannot be replaced, as when another program holds it
    expect(() => saveCase("ab12cd34", { session: session("Version 2"), markdown: "# v2", label: "case", baseRevision: 1 })).toThrow();
    expect(loadCase("ab12cd34")).toMatchObject({ session: session(null), revision: 1 });

    rmSync(markdown, { recursive: true });
    expect(saveCase("ab12cd34", { session: session("Version 2"), markdown: "# v2", label: "case", baseRevision: 1 })).toMatchObject({ ok: true, revision: 2 });
    expect(readFileSync(markdown, "utf8")).toBe("# v2");
  });

  it("never brings back a case put in the trash or whose folder was deleted", () => {
    saveCase("ab12cd34", { session: session(null), markdown: "", label: "case" });
    trashCase("ab12cd34");
    expect(saveCase("ab12cd34", { session: session(null), markdown: "", label: "case", baseRevision: 1 })).toEqual({ ok: false, reason: "gone" });
    expect(saveCase("ab12cd34", { session: session(null), markdown: "", label: "case" })).toEqual({ ok: false, reason: "gone" });
    expect(readdirSync(dir)).toEqual(["_corbeille"]);

    const other = folderOf(saveCase("ef56ab78", { session: session(null), markdown: "", label: "case" }));
    rmSync(path.join(dir, other), { recursive: true });
    expect(saveCase("ef56ab78", { session: session(null), markdown: "", label: "case", baseRevision: 1 })).toEqual({ ok: false, reason: "gone" });
    expect(readdirSync(dir)).toEqual(["_corbeille"]);
  });
});

describe("cases API", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "consultant-dots-cases-"));
    process.env.CONSULTANT_DOTS_CASES_DIR = dir;
  });
  afterEach(() => {
    delete process.env.CONSULTANT_DOTS_CASES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = { params: Promise.resolve({ id: "ab12cd34" }) };
  const request = (method: string, body?: unknown) =>
    new Request("http://127.0.0.1:3000/api/cases/ab12cd34", {
      method,
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const put = (baseRevision: number | null, caseText: string, more: object = {}) =>
    PUT(request("PUT", { session: { caseText, stages: {}, notes: { case: "Note" } }, markdown: "", label: "case", baseRevision, ...more }), ctx);

  it("hands out the revision and answers 409 to a save from a stale tab, 410 once the case is in the trash", async () => {
    const first = await put(null, "Un case.");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revision: 1 });

    const opened = await GET(request("GET"), ctx);
    expect(opened.headers.get("X-Case-Revision")).toBe("1");
    expect(await opened.json()).toEqual({ caseText: "Un case.", stages: {}, notes: { case: "Note" } });

    expect((await put(1, "Version 2")).status).toBe(200);
    expect((await put(1, "Version 3")).status).toBe(409);
    // The same content again, as a page reloaded before its answer sends it: nothing to overwrite.
    const again = await put(1, "Version 2");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ revision: 2 });
    trashCase("ab12cd34");
    expect((await put(2, "Version 3")).status).toBe(410);
    expect((await GET(request("GET"), ctx)).status).toBe(404);
  });

  it("accepts building on the tab's own unanswered save", async () => {
    expect((await put(null, "Un case.", { writeId: "w1" })).status).toBe(200);
    const next = await put(null, "Suite", { writeId: "w2", unconfirmed: ["w1"] });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ revision: 2 });
    expect((await put(null, "Autre", { writeId: "w3", unconfirmed: ["w1"] })).status).toBe(409);
  });
});
