import { and, eq, notInArray, sql } from "drizzle-orm";
import { db, news } from "./db/index.ts";

export type Source = "hn" | "github" | "hf" | "papers" | "lobsters" | "devto";
type Item = { source: Source; title: string; url: string; summary: string; score: number; publishedAt: Date | null };

const get = async (url: string) => {
  const res = await fetch(url, { headers: { "user-agent": "zippy", accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json() as Promise<any>;
};

const sources: Record<Source, () => Promise<Item[]>> = {
  hn: async () =>
    (await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30")).hits.map((h: any) => ({
      source: "hn", title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      summary: `${h.num_comments ?? 0} comments`, score: h.points ?? 0, publishedAt: new Date(h.created_at),
    })),
  // ponytail: GitHub has no trending API; repos created this week by stars is close. Unauth limit 10 req/min, plenty.
  github: async () => {
    const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    return (await get(`https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=25`)).items.map((r: any) => ({
      source: "github", title: r.full_name, url: r.html_url, summary: [r.language, r.description].filter(Boolean).join(" · "), score: r.stargazers_count, publishedAt: new Date(r.created_at),
    }));
  },
  hf: async () =>
    (await get("https://huggingface.co/api/models?sort=trendingScore&limit=25")).map((m: any) => ({
      source: "hf", title: m.id, url: `https://huggingface.co/${m.id}`, summary: [m.pipeline_tag, `${m.downloads ?? 0} downloads`].filter(Boolean).join(" · "), score: m.likes ?? 0, publishedAt: m.createdAt ? new Date(m.createdAt) : null,
    })),
  // API returns newest first; rank by upvotes like the HF papers page.
  papers: async () =>
    ((await get("https://huggingface.co/api/daily_papers?limit=50")) as any[])
      .sort((a, b) => b.paper.upvotes - a.paper.upvotes)
      .slice(0, 25)
      .map(({ paper: p }) => ({
        source: "papers", title: p.title, url: `https://huggingface.co/papers/${p.id}`, summary: p.summary ?? "", score: p.upvotes ?? 0, publishedAt: new Date(p.publishedAt),
      })),
  lobsters: async () =>
    ((await get("https://lobste.rs/hottest.json")) as any[]).slice(0, 25).map((s) => ({
      source: "lobsters", title: s.title, url: s.url || s.comments_url, summary: [s.tags.join(", "), `${s.comment_count} comments`].join(" · "), score: s.score, publishedAt: new Date(s.created_at),
    })),
  devto: async () =>
    ((await get("https://dev.to/api/articles?top=1&per_page=25")) as any[]).map((a) => ({
      source: "devto", title: a.title, url: a.url, summary: a.description ?? "", score: a.public_reactions_count ?? 0, publishedAt: new Date(a.published_timestamp),
    })),
};

export let refreshedAt: Date | null = null;
let running: Promise<string[]> | null = null;

/** Pull every source. A failed source keeps its previous items; returns the errors. */
export const refreshNews = () => (running ??= doRefresh().finally(() => (running = null)));

async function doRefresh() {
  const errors: string[] = [];
  for (const [source, fetchItems] of Object.entries(sources) as [Source, () => Promise<Item[]>][]) {
    const items = await fetchItems().catch((e: Error) => (errors.push(`${source}: ${e.message}`), null));
    if (!items?.length) continue;
    const urls = [...new Map(items.map((i) => [i.url, i])).values()];
    await db.transaction(async (tx) => {
      const keep = urls.map((i) => i.url);
      await tx.delete(news).where(and(eq(news.source, source), eq(news.saved, false), notInArray(news.url, keep)));
      await tx.update(news).set({ rank: null }).where(and(eq(news.source, source), notInArray(news.url, keep)));
      await tx
        .insert(news)
        .values(urls.map((i, rank) => ({ ...i, rank })))
        .onConflictDoUpdate({ target: news.url, set: { title: sql`excluded.title`, summary: sql`excluded.summary`, score: sql`excluded.score`, rank: sql`excluded.rank` } });
    });
  }
  refreshedAt = new Date();
  if (errors.length) console.error("[news]", errors.join("; "));
  return errors;
}

export const listNews = () => db.select().from(news).orderBy(sql`${news.rank} asc nulls last`, sql`${news.createdAt} desc`);
export const setSaved = (id: string, saved: boolean) => db.update(news).set({ saved }).where(eq(news.id, id)).returning().then((r) => r[0]);
