"use client";

import type { Source } from "@/lib/schemas/common";
import { SOURCE_LABELS } from "@/lib/domain/labels";
import { describeId, sourceOfBasis } from "@/lib/prompts/brief";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBrief } from "./hooks";

const SOURCE_STYLES: Record<Source, string> = {
  case: "border-slate-300 bg-slate-100 text-slate-700",
  client: "border-sky-300 bg-sky-50 text-sky-700",
  assumption: "border-dashed border-amber-400 bg-amber-50 text-amber-800",
};

export function SourceChip({ source, className }: { source: Source; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded border px-1 text-[9px] font-semibold tracking-wide uppercase",
        SOURCE_STYLES[source],
        className,
      )}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}

/** Chips for the F#/A#/Q#/C# ids a claim rests on, preceded by the claim's overall source. */
export function BasisChips({ basis, showSource = true }: { basis: readonly (string | undefined)[]; showSource?: boolean }) {
  const brief = useBrief();
  const ids = basis.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!brief) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {showSource && <SourceChip source={sourceOfBasis(ids, brief)} />}
      {ids.map((id) => (
        <IdChip key={id} id={id} source={sourceOfBasis([id], brief)} text={describeId(id, brief)} />
      ))}
    </span>
  );
}

export function IdChip({ id, source, text }: { id: string; source: Source; text: string | null }) {
  const chip = (
    <span
      className={cn(
        "inline-flex h-4 cursor-default items-center rounded border px-1 font-mono text-[10px]",
        SOURCE_STYLES[source],
      )}
    >
      {id}
    </span>
  );
  if (!text) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}
