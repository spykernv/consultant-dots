"use client";

import { useState } from "react";
import { Check, ChevronRight, Copy, Mic, Sparkles, Swords } from "lucide-react";
import type { OralRestitution } from "@/lib/schemas/oral";
import { useSession } from "@/lib/store/session-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChallengePanel } from "./ChallengePanel";
import { compact, useStageView, type DeepPartial } from "./hooks";
import { StageStatus } from "./StageStatus";
import { Placeholder, Zone } from "./Zone";

function scriptOf(oral: DeepPartial<OralRestitution>): string {
  const lines = [oral.opening ?? ""];
  for (const section of compact(oral.sections)) {
    lines.push("", `${section.title ?? ""}`);
    for (const bullet of compact(section.bullets)) lines.push(`- ${bullet.point ?? ""}${bullet.detail ? ` — ${bullet.detail}` : ""}`);
  }
  lines.push("", oral.closing ?? "");
  return lines.join("\n").trim();
}

function Bullet({ point, detail, open, onToggle }: { point?: string; detail?: string; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} className="group flex w-full items-start gap-1 text-left text-sm text-slate-800">
        <ChevronRight className={cn("mt-1 size-3.5 shrink-0 text-slate-400 transition-transform", open && "rotate-90")} />
        <span className="group-hover:text-indigo-800">{point}</span>
      </button>
      {open && detail && <p className="mt-0.5 mb-1 ml-4.5 border-l-2 border-indigo-100 pl-2 text-xs leading-relaxed text-slate-600">{detail}</p>}
    </li>
  );
}

function OralContent({ data, openAll }: { data: DeepPartial<OralRestitution> | null; openAll: boolean }) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  if (!data) {
    return <Placeholder>Ton pitch de 2 à 4 minutes, en puces avec détails dépliables, arrive en dernier.</Placeholder>;
  }
  const differentiators = compact(data.differentiators);
  return (
    <div className="space-y-3">
      {data.opening && (
        <p className="flex gap-2 rounded-lg bg-indigo-50 p-2.5 text-sm font-medium text-indigo-950">
          <Mic className="mt-0.5 size-4 shrink-0 text-indigo-600" />« {data.opening} »
        </p>
      )}
      {compact(data.sections).map((section, si) => (
        <section key={si}>
          <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
            {si + 1}. {section.title}
          </h3>
          <ul className="space-y-0.5">
            {compact(section.bullets).map((b, bi) => {
              const key = `${si}-${bi}`;
              return (
                <Bullet
                  key={key}
                  point={b.point}
                  detail={b.detail}
                  open={openAll || !!opened[key]}
                  onToggle={() => setOpened((o) => ({ ...o, [key]: !(openAll || o[key]) }))}
                />
              );
            })}
          </ul>
        </section>
      ))}
      {data.closing && <p className="text-sm text-slate-800 italic">« {data.closing} »</p>}
      {differentiators.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5">
          <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold text-amber-900">
            <Sparkles className="size-3.5" /> Les points qui font la différence
          </h3>
          <ul className="space-y-1.5">
            {differentiators.map((d, i) => (
              <li key={i} className="text-xs">
                <div className="font-medium text-slate-900">{d.point}</div>
                {d.howToSayIt && <div className="text-slate-600 italic">« {d.howToSayIt} »</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function OralPanel({ className }: { className?: string }) {
  const gatePassed = useSession((s) => s.gatePassed);
  const { data } = useStageView("oral");
  const [tab, setTab] = useState<"oral" | "challenge">("oral");
  const [openAll, setOpenAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const actionsBar =
    tab === "oral" && data ? (
      <>
        <Button size="xs" variant="ghost" className="text-slate-500" onClick={() => setOpenAll((v) => !v)}>
          {openAll ? "Tout replier" : "Tout déplier"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="text-slate-500"
          onClick={() =>
            void navigator.clipboard.writeText(scriptOf(data)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check /> : <Copy />} Copier
        </Button>
      </>
    ) : null;

  return (
    <Zone
      title="Oral & challenge"
      notesKey="oral"
      status={
        <span className="flex items-center gap-2">
          <StageStatus stages={["oral", "challenge"]} />
          {tab === "oral" && data?.duration && <span className="text-[11px] text-slate-400">{data.duration}</span>}
        </span>
      }
      actions={actionsBar}
      className={className}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as "oral" | "challenge")}>
        <TabsList className="mb-2 w-full">
          <TabsTrigger value="oral">
            <Mic /> Restitution orale
          </TabsTrigger>
          <TabsTrigger value="challenge">
            <Swords /> Challenge ma réponse
          </TabsTrigger>
        </TabsList>
        <TabsContent value="oral" className={cn(!gatePassed && "opacity-60")}>
          <OralContent data={data} openAll={openAll} />
        </TabsContent>
        <TabsContent value="challenge">
          <ChallengePanel />
        </TabsContent>
      </Tabs>
    </Zone>
  );
}
