import { and, eq, inArray, sql } from "drizzle-orm";
import type { TicketInput } from "@zippy/shared";
import { db, orgs, pipelines, ticketFolders, tickets } from "./db/index.ts";
import { startPipeline } from "./pipeline.ts";

type TicketRow = typeof tickets.$inferSelect;

/** Replace a ticket's folder set, keeping worktree/PR state of folders that stay. */
export async function setFolders(ticketId: string, workspaceIds: string[]) {
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(ticketFolders).where(eq(ticketFolders.ticketId, ticketId));
    const drop = existing.filter((f) => !workspaceIds.includes(f.workspaceId)).map((f) => f.workspaceId);
    if (drop.length) await tx.delete(ticketFolders).where(and(eq(ticketFolders.ticketId, ticketId), inArray(ticketFolders.workspaceId, drop)));
    for (const [position, workspaceId] of workspaceIds.entries()) {
      await tx
        .insert(ticketFolders)
        .values({ ticketId, workspaceId, position })
        .onConflictDoUpdate({ target: [ticketFolders.ticketId, ticketFolders.workspaceId], set: { position } });
    }
  });
}

export const hasFolders = async (ticketId: string) => (await db.select().from(ticketFolders).where(eq(ticketFolders.ticketId, ticketId)).limit(1)).length > 0;

export async function autoStart(ticket: TicketRow) {
  const [p] = await db.select().from(pipelines).where(and(eq(pipelines.orgId, ticket.orgId), eq(pipelines.autoStart, true)));
  if (p && (await hasFolders(ticket.id))) await startPipeline(ticket.id, p.id);
}

/** New ticket with folders. Local tickets get the next org identifier; Linear ones bring theirs. */
export async function createTicket(
  orgId: string,
  { workspaceIds, ...input }: TicketInput,
  extra: { parentId?: string | null; linear?: { identifier: string; linearId: string; linearUrl: string } } = {},
) {
  const ticket = await db.transaction(async (tx) => {
    let identifier = extra.linear?.identifier;
    while (!identifier) {
      const [o] = await tx.update(orgs).set({ ticketSeq: sql`${orgs.ticketSeq} + 1` }).where(eq(orgs.id, orgId)).returning();
      const next = `${o!.key}-${o!.ticketSeq}`;
      // skip ids already taken in this org (e.g. a Linear ticket with the same key)
      if (!(await tx.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.orgId, orgId), eq(tickets.identifier, next))).limit(1)).length) identifier = next;
    }
    const [t] = await tx.insert(tickets).values({ ...input, orgId, identifier, parentId: extra.parentId ?? null, linearId: extra.linear?.linearId, linearUrl: extra.linear?.linearUrl }).returning();
    return t!;
  });
  await setFolders(ticket.id, workspaceIds);
  return ticket;
}
