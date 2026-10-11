import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, useApiMutation, useNews, type News } from "@/lib/api";
import { ago, cn } from "@/lib/utils";

const SOURCES = { hn: "Hacker News", github: "GitHub", hf: "Models", papers: "Papers", lobsters: "Lobsters", devto: "DEV" } as const;
const UNIT = { hn: "points", github: "stars", hf: "likes", papers: "upvotes", lobsters: "points", devto: "reactions" } as const;
type Filter = keyof typeof SOURCES | "all" | "saved";
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

export function NewsPage() {
  const qc = useQueryClient();
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
  const items = (data?.items ?? []).filter((n) => (filter === "saved" ? n.saved : n.rank !== null && (filter === "all" || n.source === filter)));
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Trending</h1>
            <p className="text-muted-foreground text-xs">{data?.refreshedAt ? `Updated ${ago(data.refreshedAt)}` : "Loading feeds…"}</p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={hours} onValueChange={changeHours}>
              <SelectTrigger size="sm" aria-label="Auto-refresh interval" className="text-xs">
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

        <div className="mb-4 flex flex-wrap gap-1" role="group" aria-label="Filter">
          {(["all", ...Object.keys(SOURCES), "saved"] as Filter[]).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "secondary" : "ghost"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "saved" ? "Saved" : SOURCES[f]}
            </Button>
          ))}
        </div>

        {items.length ? (
          <ul className="grid grid-cols-1 gap-2">
            {items.map((n) => (
              <li key={n.id} className="bg-card flex min-w-0 items-start gap-3 rounded-xl border px-3 py-2.5">
                <a href={n.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
                  <div className="text-sm font-medium break-words hover:underline">{n.title}</div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-xs">
                    <span className="shrink-0">{SOURCES[n.source]}</span>
                    <span className="shrink-0">{n.score.toLocaleString()} {UNIT[n.source]}</span>
                    {n.publishedAt && <span className="shrink-0">{ago(n.publishedAt)}</span>}
                    {n.readMinutes && <span className="shrink-0">{n.readMinutes} min read</span>}
                    <span className="line-clamp-2 basis-full break-words">{n.summary}</span>
                  </div>
                </a>
                <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => save(n)} aria-label={n.saved ? "Unsave" : "Save"} aria-pressed={n.saved}>
                  <Star className={cn(n.saved ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground py-16 text-center text-sm">{isLoading ? "Fetching the latest…" : filter === "saved" ? "Star a story to keep it here." : "Nothing here. Try Refresh."}</p>
        )}
      </div>
    </div>
  );
}
