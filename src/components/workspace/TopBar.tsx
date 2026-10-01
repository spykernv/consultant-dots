"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  CircleDot,
  Copy,
  Download,
  FileText,
  FileType2,
  Loader2,
  Network,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Square,
  Timer as TimerIcon,
  Trash2,
  X,
} from "lucide-react";
import type { StageId } from "@/lib/schemas";
import { toMermaid } from "@/lib/diagram/to-mermaid";
import { domainLabel } from "@/lib/domain/domains";
import { downloadText, exportFilename } from "@/lib/export/download";
import { sessionToMarkdown } from "@/lib/export/markdown";
import { flushAutosave, keepCopy, useSaveState, type SaveState } from "@/lib/store/autosave";
import { actions, timerRemaining } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ReportPreview } from "@/components/report/ReportPreview";
import { useNow } from "./hooks";

const STEPS: { label: string; stages: StageId[] }[] = [
  { label: "Identification", stages: ["classify", "frame"] },
  { label: "Questions", stages: ["questions"] },
  { label: "Diagnostic", stages: ["diagnose", "currentState"] },
  { label: "Options", stages: ["options"] },
  { label: "Cible", stages: ["target"] },
  { label: "Roadmap", stages: ["roadmap"] },
  { label: "Oral", stages: ["oral"] },
];

function Stepper() {
  const stages = useSession((s) => s.stages);
  const gatePassed = useSession((s) => s.gatePassed);
  return (
    <ol className="hidden items-center gap-0.5 lg:flex">
      {STEPS.map((step, i) => {
        const runs = step.stages.map((id) => stages[id]);
        const done = runs.every((r) => r.status === "done") && (step.label !== "Questions" || gatePassed);
        const running = runs.some((r) => r.status === "running");
        const failed = runs.some((r) => r.status === "error" || r.status === "interrupted");
        const waiting = step.label === "Questions" && runs[0].status === "done" && !gatePassed;
        return (
          <li key={step.label} className="flex items-center gap-1">
            {i > 0 && <span className="h-px w-2 bg-slate-300" />}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px]",
                done && "border-emerald-200 bg-emerald-50 text-emerald-700",
                running && "border-indigo-200 bg-indigo-50 text-indigo-700",
                failed && "border-rose-200 bg-rose-50 text-rose-700",
                waiting && "border-amber-300 bg-amber-50 text-amber-800",
                !done && !running && !failed && !waiting && "border-slate-200 text-slate-400",
              )}
            >
              {done ? (
                <Check className="size-3" />
              ) : running ? (
                <Loader2 className="size-3 animate-spin" />
              ) : failed ? (
                <X className="size-3" />
              ) : (
                <CircleDot className="size-3" />
              )}
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Timer({ compact = false }: { compact?: boolean }) {
  const timer = useSession((s) => s.timer);
  const now = useNow(1000, timer.startedAt !== null);
  const remaining = timerRemaining(timer, now);
  const minutes = Math.floor(remaining / 60);
  const secs = Math.floor(remaining % 60);
  const running = timer.startedAt !== null;
  const tone = remaining <= 60 ? "text-rose-600" : remaining <= 180 ? "text-amber-600" : "text-slate-700";

  return (
    <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-1.5 py-0.5">
      <TimerIcon className={cn("size-3.5", tone)} />
      <span className={cn("w-11 text-center font-mono text-sm font-semibold tabular-nums", tone)}>
        {String(minutes).padStart(2, "0")}:{String(secs).padStart(2, "0")}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={running ? "Pause" : "Démarrer le chrono"}
        onClick={() => (running ? actions.pauseTimer() : actions.startTimer())}
      >
        {running ? <Pause /> : <Play />}
      </Button>
      {!compact && (
        <Button size="icon-xs" variant="ghost" aria-label="Réinitialiser le chrono" onClick={() => actions.resetTimer()}>
          <RotateCcw />
        </Button>
      )}
    </div>
  );
}

type Health = {
  engine?: "cli" | "api";
  ok: boolean;
  binFound: boolean;
  version: string | null;
  loggedIn: boolean | null;
  subscriptionType: string | null;
  model: string;
  rateLimit: { fiveHourUtilization: number | null; sevenDayUtilization: number | null } | null;
  error: string | null;
};

export function HealthBadge() {
  const mock = useSession((s) => s.mock && s.started);
  const lastDone = useSession((s) => Object.values(s.stages).filter((r) => r.status === "done").length);
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json() as Promise<Health>)
      .then((h) => !cancelled && setHealth(h))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [lastDone]);

  if (mock) {
    return <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700">Mode démo</Badge>;
  }
  if (!health && !failed) {
    return (
      <Badge variant="outline" className="text-slate-500">
        <Loader2 className="animate-spin" /> Connexion…
      </Badge>
    );
  }
  const ok = health?.ok ?? false;
  const api = health?.engine === "api";
  const usage = health?.rateLimit?.fiveHourUtilization;
  const model = health?.model.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2") ?? "";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn("cursor-help", ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700")}
        >
          {ok ? <Check /> : <ShieldAlert />}
          {api ? "API Claude" : "Claude Code"}{ok ? ` · ${model}` : " indisponible"}
          {ok && !api && usage != null ? ` · ${Math.round(usage * 100)} %` : ""}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {failed || !health
          ? "Impossible de joindre le serveur local."
          : health.error ??
            (api
              ? `Moteur API · modèle ${health.model} · facturé au token sur ta clé API`
              : `CLI ${health.version ?? "?"} · connexion ${health.subscriptionType ?? "claude.ai"} · modèle ${health.model}` +
                (usage != null ? ` · quota 5 h utilisé : ${Math.round(usage * 100)} %` : ""))}
      </TooltipContent>
    </Tooltip>
  );
}

export function ConfidentialityNotice({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-[11px] text-amber-800", className)}>
      <ShieldAlert className="size-3.5 shrink-0" />
      Ne saisissez aucune information confidentielle, personnelle ou client. Session locale uniquement.
    </p>
  );
}

function ExportMenu() {
  const hasCurrent = useSession((s) => s.stages.currentState.data !== null);
  const hasTarget = useSession((s) => s.stages.target.data !== null);
  const hasAnalysis = useSession((s) => s.stages.frame.data !== null);
  const [copied, setCopied] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const closeReport = useCallback(() => setReportOpen(false), []);

  const markdown = () => sessionToMarkdown(useSession.getState());
  const mermaid = (stage: "currentState" | "target") => {
    const data = useSession.getState().stages[stage].data;
    return data ? `${toMermaid(data.diagram)}\n` : "";
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            {copied ? <Check /> : <Download />} {copied ? "Copié" : "Exporter"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs text-slate-500">Rapport</DropdownMenuLabel>
          <DropdownMenuItem disabled={!hasAnalysis} onSelect={() => setReportOpen(true)}>
            <FileType2 /> PDF avec synthèse
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-slate-500">Tout le case (+ tes notes)</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => downloadText(exportFilename(useSession.getState(), ".md"), markdown())}
          >
            <FileText /> Télécharger le Markdown (.md)
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void navigator.clipboard.writeText(markdown()).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            <Copy /> Copier le Markdown
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-slate-500">Schémas Mermaid</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={!hasCurrent}
            onSelect={() =>
              downloadText(exportFilename(useSession.getState(), "-existant.mmd"), mermaid("currentState"), "text/plain;charset=utf-8")
            }
          >
            <Network /> Schéma existant (.mmd)
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasTarget}
            onSelect={() =>
              downloadText(exportFilename(useSession.getState(), "-cible.mmd"), mermaid("target"), "text/plain;charset=utf-8")
            }
          >
            <Network /> Schéma cible (.mmd)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {reportOpen && <ReportPreview onClose={closeReport} />}
    </>
  );
}

const SAVE_TEXT = {
  saving: "Enregistrement…",
  saved: "Enregistré",
  error: "Non enregistré",
  conflict: "Modifié dans un autre onglet",
  gone: "Case supprimé",
} as const;

const SAVE_HELP = {
  error: "Le serveur ne répond pas : nouvel essai dans quelques secondes.",
  conflict:
    "Un autre onglet a enregistré ce case depuis : cet onglet ne l'enregistre plus, pour ne pas écraser ce travail. Ferme-le et rouvre-le depuis l'accueil pour retrouver la dernière version, ou garde une copie de la version de cet onglet.",
  gone: "Ce case a été mis à la corbeille, ou son dossier a été supprimé : cet onglet ne l'enregistre plus. Garde une copie pour conserver la version de cet onglet.",
} as const;

function SaveIndicator() {
  const { status, folder } = useSaveState();
  const mock = useSession((s) => s.mock);
  if (mock || status === "idle") return null;
  const blocked = status === "conflict" || status === "gone";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn("inline-flex items-center gap-1 text-[11px]", status === "saving" || status === "saved" ? "text-slate-500" : "text-rose-600")}
        title={status === "saving" || status === "saved" ? (folder ? `cases/${folder}` : undefined) : SAVE_HELP[status]}
      >
        {status === "saving" ? <Loader2 className="size-3 animate-spin" /> : status === "saved" ? <Check className="size-3 text-emerald-600" /> : <ShieldAlert className="size-3" />}
        {SAVE_TEXT[status]}
      </span>
      {blocked && (
        <Button size="xs" variant="outline" onClick={() => keepCopy()}>
          Garder une copie
        </Button>
      )}
    </span>
  );
}

const NOT_SAVED: Partial<Record<SaveState["status"], string>> = {
  conflict:
    "Ce case a été modifié dans un autre onglet : les modifications faites ici ne sont PAS enregistrées et seront perdues (« Garder une copie » les enregistre à part).",
  gone: "Ce case n'est plus dans cases/ (mis à la corbeille ou supprimé) : tu ne pourras pas le rouvrir depuis l'accueil (« Garder une copie » enregistre la version de cet onglet à part).",
};

function CloseButton() {
  const savedId = useSession((s) => s.savedId);
  const [closing, setClosing] = useState(false);

  const close = async () => {
    let message = "Effacer la session ? Le case et l'analyse seront supprimés de cet onglet.";
    if (useSession.getState().savedId) {
      // Saved first, so the last edits are not lost and the dialog says what is really on disk. A server that never
      // answers must not keep the case open: past 15 s it counts as not saved (the request itself goes on).
      setClosing(true);
      const saved = await Promise.race([flushAutosave(), new Promise<false>((resolve) => setTimeout(resolve, 15_000, false))]);
      setClosing(false);
      message = saved
        ? "Fermer ce case ? Il est enregistré dans le dossier cases/ et tu pourras le rouvrir depuis l'accueil."
        : `${NOT_SAVED[useSaveState.getState().status] ?? "L'enregistrement a échoué (le serveur ne répond pas) : les dernières modifications ne sont PAS enregistrées dans cases/ et seront perdues."} Fermer quand même ?`;
    }
    if (window.confirm(message)) actions.clear();
  };

  return (
    <Button size="sm" variant="ghost" className="text-slate-500" disabled={closing} onClick={() => void close()}>
      {closing ? <Loader2 className="animate-spin" /> : <Trash2 />} {savedId ? "Fermer le case" : "Effacer la session"}
    </Button>
  );
}

export function TopBar() {
  const classification = useSession((s) => s.stages.classify.data);
  const anyRunning = useSession((s) => Object.values(s.stages).some((r) => r.status === "running"));
  const canResume = useSession(
    (s) => !anyRunning && Object.values(s.stages).some((r) => r.status === "interrupted" || r.status === "error"),
  );

  return (
    <header className="shrink-0 border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-slate-900">Consultant Dots</span>
          <span className="text-[11px] text-slate-400">Business case tech</span>
        </div>
        {classification && (
          <div className="flex items-center gap-1.5">
            <Badge className="bg-indigo-700 text-white">
              {domainLabel(classification.primaryDomain)} · {Math.round(classification.confidence)} %
            </Badge>
            {classification.secondaryDomains.length > 0 && (
              <Badge variant="outline" className="max-w-60 text-slate-600">
                <span className="truncate">+ {classification.secondaryDomains.map(domainLabel).join(", ")}</span>
              </Badge>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Timer />
          <HealthBadge />
          <ExportMenu />
          {anyRunning && (
            <Button size="sm" variant="outline" onClick={() => actions.stop()}>
              <Square /> Arrêter
            </Button>
          )}
          {canResume && (
            <Button size="sm" variant="outline" onClick={() => actions.resume()}>
              <Play /> Reprendre
            </Button>
          )}
          <SaveIndicator />
          <CloseButton />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-100 bg-slate-50/60 px-4 py-1">
        <Stepper />
        <ConfidentialityNotice />
      </div>
    </header>
  );
}
