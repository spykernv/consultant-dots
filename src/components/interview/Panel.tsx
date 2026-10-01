import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Same shell as the workspace zones, without maximize and notes: the interview is one focused screen. */
export function Panel({
  title,
  status,
  className,
  bodyClassName,
  footer,
  children,
}: {
  title: string;
  status?: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      <header className="flex min-h-10 flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <h2 className="text-[11px] font-semibold tracking-[0.12em] whitespace-nowrap text-slate-500 uppercase">{title}</h2>
        {status}
      </header>
      <div className={cn("min-h-0 flex-1 overflow-auto p-3", bodyClassName)}>{children}</div>
      {footer && <div className="shrink-0 border-t border-slate-100 p-3">{footer}</div>}
    </section>
  );
}
