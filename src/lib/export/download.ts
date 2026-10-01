import { domainLabel } from "@/lib/domain/domains";
import type { Session } from "@/lib/store/machine";

export function downloadText(filename: string, text: string, mime = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function exportFilename(s: Session, suffix: string, now = new Date()) {
  const domain = s.stages.classify.data ? domainLabel(s.stages.classify.data.primaryDomain) : "case";
  const slug = domain
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `consultant-dots-${slug}-${stamp}${suffix}`;
}
