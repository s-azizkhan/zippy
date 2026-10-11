import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Boxes, Clock, FileText, Flame, GitFork, Layers, MessagesSquare, Newspaper, PenLine, RefreshCw, Star, type LucideIcon } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useApiMutation, useNews, type News } from "@/lib/api";
import { ago, cn } from "@/lib/utils";

type Source = News["source"];
const SOURCES = { hn: "Hacker News", github: "GitHub", hf: "Models", papers: "Papers", lobsters: "Lobsters", devto: "DEV" } as const;
const UNIT = { hn: "points", github: "stars", hf: "likes", papers: "upvotes", lobsters: "points", devto: "reactions" } as const;
const ICONS: Record<Source | "all" | "saved", LucideIcon> = { all: Layers, hn: Flame, github: GitFork, hf: Boxes, papers: FileText, lobsters: MessagesSquare, devto: PenLine, saved: Star };
const TINTS: Record<Source | "all" | "saved", string> = {
  all: "var(--primary)",
  hn: "oklch(0.7 0.19 45)",
  github: "oklch(0.72 0.03 260)",
  hf: "oklch(0.8 0.16 85)",
  papers: "oklch(0.68 0.17 300)",
  lobsters: "oklch(0.64 0.2 25)",
  devto: "oklch(0.72 0.12 195)",
  saved: "oklch(0.8 0.16 80)",
};
// Sources linking out to arbitrary sites; show the domain so the reader knows where they land.
const EXTERNAL: Source[] = ["hn", "lobsters"];
type Filter = keyof typeof SOURCES | "all" | "saved";
const FILTERS = ["all", ...Object.keys(SOURCES), "saved"] as Filter[];
const INTERVALS = { "0.5": "30 minutes", "1": "hour", "2": "2 hours", "6": "6 hours", "12": "12 hours", "24": "day", "0": "never" } as const;
type Interval = keyof typeof INTERVALS;
const KEY = "news.refreshHours";
const loadInterval = (): Interval => {
  try {
    const v = localStorage.getItem(KEY);
    return v && v in INTERVALS ? (v as Interval) : "2";
  } catch {
    return "2";
  }
};
const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const SPRING = { type: "spring", stiffness: 420, damping: 36, mass: 0.6 } as const;

export function NewsPage() {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const { data, isLoading } = useNews();
  const [filter, setFilter] = useState<Filter>("all");
  const [hours, setHours] = useState(loadInterval);
  const refresh = useApiMutation((auto: boolean) =>
    api.post<{ errors: string[] }>("/news/refresh", {}, true).then((r) => {
      qc.setQueryData(["news"], r);
      if (r.errors.length) toast.error(`Some feeds failed: ${r.errors.join("; ")}`);
      else if (!auto) toast.success("News refreshed");
    }),
  );
  // ponytail: refresh only runs while this page is open; stale feeds catch up on next visit.
  const { mutate, isPending } = refresh;
  useEffect(() => {
    const ms = Number(hours) * 3600_000;
    if (!ms || !data) return;
    const tick = () => !isPending && Date.now() - new Date(data.refreshedAt ?? 0).getTime() >= ms && mutate(true);
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [hours, data, isPending, mutate]);
  const changeHours = (v: string) => {
    setHours(v as Interval);
    try {
      localStorage.setItem(KEY, v);
    } catch {}
  };
  const save = async (n: News) => {
    qc.setQueryData<{ items: News[] }>(["news"], (d) => d && { ...d, items: d.items.map((i) => (i.id === n.id ? { ...i, saved: !n.saved } : i)) });
    await api.patch(`/news/${n.id}`, { saved: !n.saved }, true).catch((e: Error) => (toast.error(e.message), qc.invalidateQueries({ queryKey: ["news"] })));
  };
  const all = data?.items ?? [];
  const show = (n: News, f: Filter) => (f === "saved" ? n.saved : n.rank !== null && (f === "all" || n.source === f));
  const items = all.filter((n) => show(n, filter));
  // Per-source top score, so the heat meter compares like with like (stars vs points).
  const { counts, top } = useMemo(() => {
    const counts = Object.fromEntries(FILTERS.map((f) => [f, all.filter((n) => show(n, f)).length])) as Record<Filter, number>;
    const top: Partial<Record<Source, number>> = {};
    for (const n of all) top[n.source] = Math.max(top[n.source] ?? 1, n.score);
    return { counts, top };
  }, [all]);
  const fresh = data?.refreshedAt && Date.now() - new Date(data.refreshedAt).getTime() < 3600_000;

  return (
    <div className="news-bg min-h-0 flex-1 overflow-x-hidden overflow-y-auto" style={{ "--tint": TINTS[filter] } as CSSProperties}>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Trending</h1>
            <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
              <span className={cn("relative grid size-2 place-items-center", !data?.refreshedAt && "opacity-0")} aria-hidden>
                {fresh && !reduce && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60" />}
                <span className={cn("size-1.5 rounded-full", fresh ? "bg-emerald-500" : "bg-muted-foreground/50")} />
              </span>
              {isPending ? <span className="shimmer">Pulling fresh stories…</span> : data?.refreshedAt ? `Updated ${ago(data.refreshedAt)}` : "Loading feeds…"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={hours} onValueChange={changeHours}>
              <SelectTrigger size="sm" aria-label="Auto-refresh interval" className="text-xs">
                <Clock className="size-3.5" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(INTERVALS).map(([v, label]) => (
                  <SelectItem key={v} value={v}>
                    {v === "0" ? "Never auto-refresh" : `Every ${label}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => mutate(false)} disabled={isPending}>
              <RefreshCw className={cn(isPending && "animate-spin")} aria-hidden /> Refresh
            </Button>
          </div>
        </header>

        <LayoutGroup id="news-filter">
          <div className="bg-muted/40 mb-5 flex flex-wrap gap-0.5 rounded-2xl border p-1" role="group" aria-label="Filter">
            {FILTERS.map((f) => {
              const Icon = ICONS[f];
              const active = filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(f)}
                  style={{ "--tint": TINTS[f] } as CSSProperties}
                  className="group/f text-muted-foreground hover:text-foreground aria-pressed:text-foreground focus-visible:ring-ring/60 relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px]"
                >
                  {active && <motion.span layoutId="news-filter-pill" aria-hidden transition={reduce ? { duration: 0 } : SPRING} className="bg-background absolute inset-0 rounded-xl border shadow-sm" />}
                  <Icon className="relative size-3.5 transition-colors group-aria-pressed/f:text-(--tint)" aria-hidden />
                  <span className="relative">{f === "all" ? "All" : f === "saved" ? "Saved" : SOURCES[f]}</span>
                  {counts[f] > 0 && <span className="text-muted-foreground relative text-[11px] tabular-nums">{counts[f]}</span>}
                </button>
              );
            })}
          </div>
        </LayoutGroup>

        {isLoading ? (
          <ul className="grid gap-2" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="flex gap-3 rounded-2xl border p-3.5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </li>
            ))}
          </ul>
        ) : items.length ? (
          <motion.ul key={filter} className="grid grid-cols-1 gap-2">
            <AnimatePresence mode="popLayout" initial>
              {items.map((n, i) => (
                <Row key={n.id} n={n} i={i} ranked={filter !== "all" && filter !== "saved"} heat={n.score / (top[n.source] ?? 1)} reduce={!!reduce} onSave={() => save(n)} />
              ))}
            </AnimatePresence>
          </motion.ul>
        ) : (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="empty-state flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center"
          >
            <span className="tint-tile grid size-10 place-items-center rounded-xl" aria-hidden>
              {filter === "saved" ? <Star className="size-4" /> : <Newspaper className="size-4" />}
            </span>
            <p className="text-muted-foreground text-sm">{filter === "saved" ? "Star a story to keep it here." : "Nothing here. Try Refresh."}</p>
          </motion.div>
        )}
      </div>
    </div>
  );
}

function Row({ n, i, ranked, heat, reduce, onSave }: { n: News; i: number; ranked: boolean; heat: number; reduce: boolean; onSave: () => void }) {
  const Icon = ICONS[n.source];
  const host = EXTERNAL.includes(n.source) ? domain(n.url) : "";
  // Cursor-following glow; CSS vars avoid re-rendering on every move.
  const spot = (e: PointerEvent<HTMLLIElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
  };
  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 10, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: { ...SPRING, delay: Math.min(i, 12) * 0.03 } }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
      onPointerMove={spot}
      style={{ "--tint": TINTS[n.source] } as CSSProperties}
      className="news-row group/row bg-card relative flex min-w-0 items-start gap-3 overflow-hidden rounded-2xl border p-3.5"
    >
      <div className="flex w-8 shrink-0 flex-col items-center gap-1.5">
        <span className="tint-tile grid size-8 place-items-center rounded-lg transition-transform duration-300 group-hover/row:scale-110 group-hover/row:-rotate-6" aria-hidden>
          <Icon className="size-4" />
        </span>
        {ranked && (
          <span className={cn("text-[10px] font-semibold tabular-nums", i < 3 ? "text-(--tint)" : "text-muted-foreground/60")} aria-label={`Rank ${i + 1}`}>
            #{i + 1}
          </span>
        )}
      </div>

      <a href={n.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-(--tint)/50">
        <div className="flex items-start gap-1.5">
          <h2 className="text-[15px] leading-snug font-medium break-words">{n.title}</h2>
          <ArrowUpRight className="text-muted-foreground mt-0.5 size-4 shrink-0 -translate-x-1 translate-y-1 opacity-0 transition-all duration-300 group-hover/row:translate-0 group-hover/row:text-(--tint) group-hover/row:opacity-100" aria-hidden />
        </div>
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-medium text-(--tint)">{SOURCES[n.source]}</span>
          {host && <span className="truncate">{host}</span>}
          <span className="inline-flex items-center gap-1.5 tabular-nums" title={`${n.score.toLocaleString()} ${UNIT[n.source]}`}>
            <span className="bg-muted relative h-1 w-8 overflow-hidden rounded-full" aria-hidden>
              <motion.span
                className="absolute inset-y-0 left-0 rounded-full bg-(--tint)"
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${Math.max(6, heat * 100)}%` }}
                transition={{ duration: 0.8, delay: 0.15 + Math.min(i, 12) * 0.03, ease: [0.2, 0.8, 0.2, 1] }}
              />
            </span>
            {n.score.toLocaleString()} {UNIT[n.source]}
          </span>
          {n.publishedAt && <span>{ago(n.publishedAt)}</span>}
          {n.readMinutes && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden />
              {n.readMinutes} min read
            </span>
          )}
        </div>
        {n.summary && <p className="text-muted-foreground/90 mt-1.5 line-clamp-2 text-[13px] leading-relaxed break-words">{n.summary}</p>}
      </a>

      <SaveButton saved={n.saved} reduce={reduce} onClick={onSave} />
    </motion.li>
  );
}

function SaveButton({ saved, reduce, onClick }: { saved: boolean; reduce: boolean; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={saved ? "Unsave" : "Save"}
      aria-pressed={saved}
      whileTap={reduce ? undefined : { scale: 0.8 }}
      className={cn(
        "hover:bg-accent focus-visible:ring-ring/60 relative z-10 grid size-8 shrink-0 place-items-center rounded-lg outline-none transition-opacity focus-visible:ring-[3px]",
        !saved && "opacity-60 group-hover/row:opacity-100",
      )}
    >
      {/* Burst ring replays on every save; keyed so it remounts. */}
      <AnimatePresence>
        {saved && !reduce && (
          <motion.span
            key="burst"
            aria-hidden
            className="absolute inset-0 rounded-full border-2 border-amber-400"
            initial={{ scale: 0.3, opacity: 1 }}
            animate={{ scale: 1.6, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>
      <motion.span key={String(saved)} initial={reduce || !saved ? false : { scale: 0.4, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 500, damping: 14 }}>
        <Star className={cn("size-4", saved ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} aria-hidden />
      </motion.span>
    </motion.button>
  );
}
