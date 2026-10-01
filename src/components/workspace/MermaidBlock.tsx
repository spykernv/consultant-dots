"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, Minimize, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MermaidView } from "@/components/mermaid/MermaidView";
import { Placeholder, useZone } from "./Zone";

export type Zoom = { fit: boolean; toggle: () => void };

export function CopyButton({ text, label = "Copier Mermaid" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-slate-500"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check /> : <Copy />} {copied ? "Copié" : label}
    </Button>
  );
}

/** A compiled Mermaid diagram with the zone's zoom, click-to-enlarge and copy controls. */
export function MermaidBlock({
  code,
  zoom,
  placeholder,
  legend,
}: {
  code: string | null;
  zoom: Zoom;
  placeholder: string;
  legend?: ReactNode;
}) {
  const { maximized, setMaximized } = useZone();
  if (!code) return <Placeholder>{placeholder}</Placeholder>;
  return (
    <div>
      <div className="flex items-center justify-end gap-1">
        {!maximized && <span className="mr-auto text-[10px] text-slate-400">Clic sur le schéma pour l&apos;agrandir</span>}
        <Button size="xs" variant="ghost" className="text-slate-500" onClick={zoom.toggle}>
          {zoom.fit ? <ZoomIn /> : <Minimize />} {zoom.fit ? "100 %" : "Ajuster"}
        </Button>
        <CopyButton text={code} />
      </div>
      <div
        className={cn(!maximized && "cursor-zoom-in")}
        onClick={() => !maximized && setMaximized(true)}
        title={maximized ? undefined : "Agrandir le schéma"}
      >
        <MermaidView code={code} fit={zoom.fit} className={cn(zoom.fit && "flex justify-center")} />
      </div>
      {legend}
    </div>
  );
}
