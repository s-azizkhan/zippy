import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { KB_KINDS, KB_LABELS, type KnowledgeInput } from "@zippy/shared";
import { db, knowledge } from "./db/index.ts";

type Row = typeof knowledge.$inferSelect;

const STOP = new Set("the and for with that this from are was not but you your use when into than then have has can will all any its our out".split(" "));

/** Lowercase search terms, stopwords dropped. Also the tsquery input, so only [a-z0-9]. */
export function terms(s: string) {
  return [...new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
}

/** Jaccard on terms: near-duplicate detection without an embedding call. */
export function similar(a: string, b: string) {
  const x = new Set(terms(a)), y = new Set(terms(b));
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const both = [...x].filter((w) => y.has(w)).length;
  return both / (x.size + y.size - both) >= 0.7;
}

/** Compact prompt lines, grouped by kind. Short id lets agents `replaces` an entry. */
export function render(rows: Pick<Row, "id" | "kind" | "text" | "url">[]) {
  return KB_KINDS.flatMap((k) =>
    rows.filter((r) => r.kind === k).map((r) => `- [${r.id.slice(0, 8)}] ${KB_LABELS[k]}: ${r.text}${r.url ? ` <${r.url}>` : ""}`),
  ).join("\n");
}

const scope = (orgId: string, workspaceIds: string[]) =>
  and(eq(knowledge.orgId, orgId), workspaceIds.length ? or(isNull(knowledge.workspaceId), inArray(knowledge.workspaceId, workspaceIds)) : isNull(knowledge.workspaceId));

// ponytail: Postgres FTS ranked per call, no index; add a GIN index on the tsvector past ~10k rows.
const doc = sql`to_tsvector('simple', ${knowledge.text} || ' ' || ${knowledge.url})`;

/** Pinned first, then best FTS match for `query`, then most used. */
export async function relevant(orgId: string, workspaceIds: string[], query: string, limit: number) {
  const q = terms(query).slice(0, 40).join(" | ");
  const rank = q ? sql`ts_rank(${doc}, to_tsquery('simple', ${q}))` : sql`0`;
  return db
    .select()
    .from(knowledge)
    .where(scope(orgId, workspaceIds))
    .orderBy(sql`${knowledge.pinned} desc, ${rank} desc, ${knowledge.uses} desc, ${knowledge.createdAt} desc`)
    .limit(limit);
}

/** Search tool: only rows that actually match. */
export async function search(orgId: string, workspaceIds: string[], query: string) {
  const q = terms(query).join(" | ");
  if (!q) return [];
  return db
    .select()
    .from(knowledge)
    .where(and(scope(orgId, workspaceIds), sql`${doc} @@ to_tsquery('simple', ${q})`))
    .orderBy(sql`ts_rank(${doc}, to_tsquery('simple', ${q})) desc`)
    .limit(15);
}

const BUDGET = 2500; // chars of knowledge per system prompt (~600 tokens)

/** System prompt section: pinned + most relevant entries within BUDGET. Bumps their `uses`. */
export async function kbPrompt(orgId: string, workspaceIds: string[], query: string) {
  const rows = await relevant(orgId, workspaceIds, query, 25);
  const kept: Row[] = [];
  let size = 0;
  for (const r of rows) {
    size += r.text.length + r.url.length + 20;
    if (size > BUDGET && kept.length) break;
    kept.push(r);
  }
  if (!kept.length) return "";
  await db.update(knowledge).set({ uses: sql`${knowledge.uses} + 1`, lastUsedAt: new Date() }).where(inArray(knowledge.id, kept.map((r) => r.id)));
  return render(kept);
}

/** Insert unless a same-scope entry has the same url or near-same text; then bump it instead. */
export async function addKnowledge(orgId: string, input: KnowledgeInput, meta: Partial<Pick<Row, "source" | "agentId" | "ticketId">> = {}) {
  const same = await db
    .select()
    .from(knowledge)
    .where(and(eq(knowledge.orgId, orgId), input.workspaceId ? eq(knowledge.workspaceId, input.workspaceId) : isNull(knowledge.workspaceId)));
  const dup = same.find((r) => (input.url && r.url === input.url) || (r.kind === input.kind && similar(r.text, input.text)));
  if (dup) {
    const [row] = await db.update(knowledge).set({ uses: dup.uses + 1, lastUsedAt: new Date() }).where(eq(knowledge.id, dup.id)).returning();
    return { row: row!, created: false };
  }
  const [row] = await db.insert(knowledge).values({ ...input, orgId, ...meta }).returning();
  return { row: row!, created: true };
}

/** Find by the short id shown in prompts. */
export async function byShortId(orgId: string, short: string) {
  short = short.replace(/[^0-9a-f-]/gi, "");
  if (short.length < 8) return undefined;
  const [row] = await db.select().from(knowledge).where(and(eq(knowledge.orgId, orgId), sql`${knowledge.id}::text like ${`${short}%`}`)).limit(1);
  return row;
}
