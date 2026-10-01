"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { domainLabel } from "@/lib/domain/domains";
import type { SavedCaseSummary } from "@/lib/server/case-store";
import type { Domain } from "@/lib/schemas/common";
import { openedFromDisk } from "@/lib/store/autosave";
import type { Session } from "@/lib/store/machine";
import { actions } from "@/lib/store/orchestrator";
import { Button } from "@/components/ui/button";

const PIPELINE_LENGTH = 9;

const when = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The cases saved under cases/, newest first; opening one restores it exactly as it was left. */
export function SavedCases() {
  const [cases, setCases] = useState<SavedCaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    fetch("/api/cases", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((list: SavedCaseSummary[]) => {
        setCases(list);
        setError(null);
      })
      .catch(() => setError("Impossible de lire tes cases enregistrés (le serveur est-il lancé ?)."));

  useEffect(() => {
    void refresh();
  }, []);

  const open = async (item: SavedCaseSummary) => {
    try {
      const res = await fetch(`/api/cases/${item.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      actions.openSaved((await res.json()) as Session, item.id);
      openedFromDisk(item.id, Number(res.headers.get("X-Case-Revision")) || 0, item.folder);
    } catch {
      setError("Ce case n'a pas pu être ouvert.");
    }
  };

  const remove = async (item: SavedCaseSummary) => {
    if (!window.confirm(`Mettre « ${item.title.slice(0, 80)} » à la corbeille ? Le dossier est déplacé dans cases/_corbeille.`)) return;
    await fetch(`/api/cases/${item.id}`, { method: "DELETE" });
    void refresh();
  };

  if (error) return <p className="text-xs text-rose-700">{error}</p>;
  if (!cases || cases.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h2 className="border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-700">
        Mes cases enregistrés <span className="font-normal text-slate-400">· dossier cases/ du projet</span>
      </h2>
      <ul className="max-h-72 divide-y divide-slate-100 overflow-auto">
        {cases.map((item) => (
          <li key={item.id} className="group flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800">{item.title || "Case sans titre"}</div>
              <div className="text-[11px] text-slate-500">
                {item.domain ? `${domainLabel(item.domain as Domain)} · ` : ""}
                {when(item.updatedAt)} · {Math.min(item.stagesDone, PIPELINE_LENGTH)}/{PIPELINE_LENGTH} étapes ·{" "}
                <span className="font-mono text-slate-400">{item.folder}</span>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void open(item)}>
              <FolderOpen /> Ouvrir
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-slate-400 hover:text-rose-600"
              aria-label="Mettre à la corbeille"
              onClick={() => void remove(item)}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
