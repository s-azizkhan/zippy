import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Star } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, useApiMutation, useNews, type News } from "@/lib/api";
import { ago, cn } from "@/lib/utils";

const SOURCES = { hn: "Hacker News", github: "GitHub", hf: "Models", papers: "Papers", lobsters: "Lobsters", devto: "DEV" } as const;
const UNIT = { hn: "points", github: "stars", hf: "likes", papers: "upvotes", lobsters: "points", devto: "reactions" } as const;
type Filter = keyof typeof SOURCES | "all" | "saved";

export function NewsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useNews();
  const [filter, setFilter] = useState<Filter>("all");
  const refresh = useApiMutation(() =>
    api.post<{ errors: string[] }>("/news/refresh", {}, true).then((r) => {
      qc.setQueryData(["news"], r);
      r.errors.length ? toast.error(`Some feeds failed: ${r.errors.join("; ")}`) : toast.success("News refreshed");
    }),
  );
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
            <p className="text-muted-foreground text-xs">{data?.refreshedAt ? `Updated ${ago(data.refreshedAt)} · refreshes every 2 hours` : "Loading feeds…"}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refresh.mutate(undefined)} disabled={refresh.isPending}>
            <RefreshCw className={cn(refresh.isPending && "animate-spin")} aria-hidden /> Refresh
          </Button>
        </header>

        <div className="mb-4 flex flex-wrap gap-1" role="group" aria-label="Filter">
          {(["all", ...Object.keys(SOURCES), "saved"] as Filter[]).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "secondary" : "ghost"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "saved" ? "Saved" : SOURCES[f]}
            </Button>
          ))}
        </div>

        {items.length ? (
          <ul className="grid gap-2">
            {items.map((n) => (
              <li key={n.id} className="bg-card flex items-start gap-3 rounded-xl border px-3 py-2.5">
                <a href={n.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium hover:underline">{n.title}</div>
                  <div className="text-muted-foreground mt-0.5 flex gap-2 text-xs">
                    <span className="shrink-0">{SOURCES[n.source]}</span>
                    <span className="shrink-0">{n.score.toLocaleString()} {UNIT[n.source]}</span>
                    {n.publishedAt && <span className="shrink-0">{ago(n.publishedAt)}</span>}
                    <span className="truncate">{n.summary}</span>
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
