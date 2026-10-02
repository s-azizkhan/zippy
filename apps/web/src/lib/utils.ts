export { cn } from "cn"

const rel = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function ago(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const [v, u] = Math.abs(s) < 3600 ? [s / 60, "minute"] : Math.abs(s) < 86400 ? [s / 3600, "hour"] : [s / 86400, "day"];
  return rel.format(Math.round(v as number), u as Intl.RelativeTimeFormatUnit);
}

/** Key events from text fields, dialogs and menus should not trigger page shortcuts. */
export const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog],[cmdk-root]");
};
