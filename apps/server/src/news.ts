import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { db, news } from "./db/index.ts";

export type Source = "hn" | "github" | "hf" | "papers" | "lobsters" | "devto";
type Item = { source: Source; title: string; url: string; summary: string; score: number; publishedAt: Date | null; readMinutes?: number | null };

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
      source: "devto", title: a.title, url: a.url, summary: a.description ?? "", score: a.public_reactions_count ?? 0, publishedAt: new Date(a.published_timestamp), readMinutes: a.reading_time_minutes ?? null,
    })),
};

// Sources linking out to articles; their reading time comes from the page itself.
const ARTICLES: Source[] = ["hn", "lobsters"];

// ponytail: raw page word count at 230 wpm, nav/footer included; JS-rendered pages read as too short and get null.
// Feed links are user-submitted: never let them reach loopback/LAN/link-local hosts.
const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");
const isPublic = (ip: string) => {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]; // IPv4-mapped IPv6
  return v4 ? !PRIVATE.check(v4, "ipv4") : !PRIVATE.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
};
const publicUrl = async (raw: string) => {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  return ips.length > 0 && ips.every(isPublic);
};

// ponytail: checks DNS before each hop but doesn't pin the IP, so DNS rebinding could slip past; pin via an undici dispatcher if this ever fetches anything sensitive.
async function readMinutes(url: string) {
  try {
    let res: Response | undefined;
    for (let hop = 0; hop < 5; hop++) {
      if (!(await publicUrl(url))) return null;
      res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 zippy" }, redirect: "manual", signal: AbortSignal.timeout(8_000) });
      const next = res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (!next) break;
      url = new URL(next, url).href;
    }
    if (!res?.ok || !res.headers.get("content-type")?.includes("text/html")) return null;
    const text = (await res.text()).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
    const words = text.split(/\s+/).filter((w) => /\w/.test(w)).length;
    return words < 150 ? null : Math.max(1, Math.round(words / 230));
  } catch {
    return null;
  }
}

/** Fill readMinutes for article links, reusing values already stored so each page is fetched once. */
async function withReadTimes(source: Source, items: Item[]) {
  if (!ARTICLES.includes(source)) return items;
  const known = new Map(
    (await db.select({ url: news.url, m: news.readMinutes }).from(news).where(and(inArray(news.url, items.map((i) => i.url)), isNotNull(news.readMinutes)))).map((r) => [r.url, r.m]),
  );
  return Promise.all(items.map(async (i) => ({ ...i, readMinutes: known.get(i.url) ?? (await readMinutes(i.url)) })));
}

export let refreshedAt: Date | null = null;
let running: Promise<string[]> | null = null;

/** Pull every source. A failed source keeps its previous items; returns the errors. */
export const refreshNews = () => (running ??= doRefresh().finally(() => (running = null)));

async function doRefresh() {
  const errors: string[] = [];
  for (const [source, fetchItems] of Object.entries(sources) as [Source, () => Promise<Item[]>][]) {
    const items = await fetchItems().catch((e: Error) => (errors.push(`${source}: ${e.message}`), null));
    if (!items?.length) continue;
    const urls = await withReadTimes(source, [...new Map(items.map((i) => [i.url, i])).values()]);
    await db.transaction(async (tx) => {
      const keep = urls.map((i) => i.url);
      await tx.delete(news).where(and(eq(news.source, source), eq(news.saved, false), notInArray(news.url, keep)));
      await tx.update(news).set({ rank: null }).where(and(eq(news.source, source), notInArray(news.url, keep)));
      await tx
        .insert(news)
        .values(urls.map((i, rank) => ({ ...i, rank })))
        .onConflictDoUpdate({ target: news.url, set: { title: sql`excluded.title`, summary: sql`excluded.summary`, score: sql`excluded.score`, rank: sql`excluded.rank`, readMinutes: sql`coalesce(excluded.read_minutes, ${news.readMinutes})` } });
    });
  }
  refreshedAt = new Date();
  if (errors.length) console.error("[news]", errors.join("; "));
  return errors;
}

export const listNews = () => db.select().from(news).orderBy(sql`${news.rank} asc nulls last`, sql`${news.createdAt} desc`);
export const setSaved = (id: string, saved: boolean) => db.update(news).set({ saved }).where(eq(news.id, id)).returning().then((r) => r[0]);
