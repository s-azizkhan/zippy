import { Archive, ArchiveRestore, ChevronDown, ListFilter, ListTodo, Star } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { FolderOpenIcon } from "@/components/ui/folder-open";
import { LayersIcon } from "@/components/ui/layers";
import { Link2Icon } from "@/components/ui/link-2";
import { ZapIcon } from "@/components/ui/zap";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Agent, Ticket, TicketStatus } from "@zippy/shared";
import { FileBrowser } from "@/components/file-browser";
import { LinearIssues } from "@/components/linear-issues";
import { LabelChips } from "@/components/pickers";
import {
  AgentAvatar,
  PRIORITY_LABEL,
  PriorityIcon,
  SourceIcon,
  STATUS,
  STATUS_ORDER,
  StatusIcon,
} from "@/components/status";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, keys, queryClient, useAgents, useTickets, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { useUI } from "@/lib/store";
import { cn, isTyping } from "@/lib/utils";

const TABS = [
  { id: "all", label: "All issues", icon: LayersIcon, statuses: null },
  {
    id: "active",
    label: "Active",
    icon: ZapIcon,
    statuses: ["needs_input", "in_review", "in_progress", "blocked", "todo"],
  },
  { id: "backlog", label: "Backlog", icon: ListTodo, statuses: ["backlog"] },
  { id: "linear", label: "Linear", icon: Link2Icon, statuses: null },
  { id: "archived", label: "Archived", icon: Archive, statuses: null },
  { id: "files", label: "Files", icon: FolderOpenIcon, statuses: null },
] as const;

const INBOX: TicketStatus[] = ["needs_input", "in_review"];
const shortDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
});

/** Ticket order as shown in the list; the issue page uses it for prev/next. */
export function useOrderedTickets() {
  const org = useOrg();
  const { data: tickets, isLoading } = useTickets(org.id);
  const [params] = useSearchParams();
  const folder = params.get("folder");
  const view = params.get("view");
  const who = params.get("who");
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const fav = params.get("fav") === "1";
  const favorites = useUI((s) => s.favorites);
  const tab =
    TABS.find(
      (t) =>
        t.id === params.get("tab") &&
        (t.id !== "linear" || org.linearConnected) &&
        (t.id !== "files" || !!folder),
    ) ?? TABS[1];
  const ordered = useMemo(() => {
    let rows = (tickets ?? []).filter((t) => t.archived === (tab.id === "archived"));
    if (folder)
      rows = rows.filter((t) =>
        t.folders.some((f) => f.workspaceId === folder),
      );
    if (who) rows = rows.filter((t) => (who === "agent" || who === "human" ? !!t.assigneeAgentId === (who === "agent") : t.assigneeAgentId === who));
    if (fav) rows = rows.filter((t) => favorites.includes(t.id));
    if (q)
      rows = rows.filter((t) =>
        `${t.identifier} ${t.title}`.toLowerCase().includes(q),
      );
    if (view === "inbox") rows = rows.filter((t) => INBOX.includes(t.status));
    else if (tab.statuses)
      rows = rows.filter((t) =>
        (tab.statuses as readonly string[]).includes(t.status),
      );
    return STATUS_ORDER.flatMap((s) => rows.filter((t) => t.status === s));
  }, [tickets, folder, view, tab, who, q, fav, favorites]);
  return { ordered, isLoading, folder, view, tab, who, q, fav };
}

/** j/k move focus between rows. */
function useRowKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.key !== "j" && e.key !== "k") ||
        isTyping(e) ||
        e.metaKey ||
        e.ctrlKey
      )
        return;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
      const i = rows.indexOf(document.activeElement as HTMLElement);
      rows[
        Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" ? 1 : -1)))
      ]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function TicketsPage() {
  const org = useOrg();
  const { ordered, isLoading, folder, view, tab, who, q, fav } = useOrderedTickets();
  const { data: agents = [] } = useAgents(org.id);
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const setNewTicketOpen = useUI((s) => s.setNewTicketOpen);
  const [params, setParams] = useSearchParams();
  const [closed, setClosed] = useState<Set<TicketStatus>>(new Set());
  useRowKeys();
  const reduce = useReducedMotion();
  const idx = TABS.findIndex((t) => t.id === tab.id);
  const prev = useRef(idx);
  const dir = Math.sign(idx - prev.current) || 1;
  useEffect(() => {
    prev.current = idx;
  }, [idx]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const title =
    view === "inbox"
      ? "Inbox"
      : folder
        ? (workspaces.find((w) => w.id === folder)?.name ?? "Folder")
        : "Issues";
  const groups = STATUS_ORDER.map((s) => ({
    status: s,
    rows: ordered.filter((t) => t.status === s),
  })).filter((g) => g.rows.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="text-[13px] font-medium">{title}</h1>
        {view !== "inbox" && (
          <div
            role="tablist"
            aria-label="Views"
            className="flex items-center gap-1"
          >
            {TABS.filter((t) => (t.id !== "linear" || org.linearConnected) && (t.id !== "files" || folder)).map(
              (t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab.id === t.id}
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    if (t.id === "active") next.delete("tab");
                    else next.set("tab", t.id);
                    setParams(next);
                  }}
                  className={cn(
                    "text-muted-foreground hover:text-foreground relative flex h-6 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium transition-colors",
                    tab.id === t.id && "text-foreground",
                  )}
                >
                  {tab.id === t.id && (
                    <motion.span
                      layoutId="tab-pill"
                      aria-hidden
                      className="bg-accent border-border absolute inset-0 rounded-md border"
                      transition={
                        reduce
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 520, damping: 28, mass: 0.9 }
                      }
                    />
                  )}
                  <t.icon className="relative size-3.5" />
                  <span className="relative">{t.label}</span>
                </button>
              ),
            )}
          </div>
        )}
        {tab.id !== "files" && tab.id !== "linear" && (
          <div className="ml-auto flex items-center gap-2">
            <Select
              value={who ?? "all"}
              onValueChange={(v) => setParam("who", v === "all" ? "" : v)}
            >
              <SelectTrigger size="sm" aria-label="Filter by assignee" className={cn("h-6 text-xs", who && "border-primary/50 text-primary")}>
                <ListFilter className="size-3.5" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="human">Human</SelectItem>
                <SelectItem value="agent">Any agent</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              aria-label="Show favorites only"
              aria-pressed={fav}
              title="Favorites"
              onClick={() => setParam("fav", fav ? "" : "1")}
              className={cn("text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-md border", fav && "border-yellow-400/50")}
            >
              <Star className={cn("size-3.5", fav && "fill-yellow-400 text-yellow-400")} aria-hidden />
            </button>
            <Input
              type="search"
              aria-label="Search issues"
              placeholder="Search…"
              value={q}
              onChange={(e) => setParam("q", e.target.value)}
              className="h-6 w-40 text-xs"
            />
          </div>
        )}
      </header>

      {tab.id === "files" && folder ? (
        <FileBrowser id={folder} />
      ) : tab.id === "linear" && view !== "inbox" ? (
        <LinearIssues />
      ) : (
        <motion.div
          key={tab.id}
          initial={reduce ? false : { opacity: 0, x: dir * 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="flex-1 overflow-y-auto overflow-x-hidden"
        >
          {isLoading && (
            <div className="grid gap-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          )}
          {!isLoading && !ordered.length && (
            <div className="text-muted-foreground grid place-items-center gap-2 p-20 text-[13px]">
              {view === "inbox"
                ? "Nothing needs you right now."
                : "No issues here."}
              {view !== "inbox" && (
                <button
                  className="text-foreground underline underline-offset-4"
                  onClick={() => setNewTicketOpen(true)}
                >
                  Create an issue (C)
                </button>
              )}
            </div>
          )}
          {groups.map(({ status, rows }) => {
            const open = !closed.has(status);
            return (
              <section key={status} aria-labelledby={`g-${status}`}>
                <h2
                  id={`g-${status}`}
                  className="bg-muted/70 sticky top-0 z-10 flex h-9 items-center gap-2 px-4 text-[13px] font-medium backdrop-blur"
                >
                  <button
                    aria-expanded={open}
                    onClick={() =>
                      setClosed((c) => {
                        const n = new Set(c);
                        if (!n.delete(status)) n.add(status);
                        return n;
                      })
                    }
                    className="flex h-full flex-1 items-center gap-2 text-left"
                  >
                    <ChevronDown
                      className={cn(
                        "text-muted-foreground size-3.5 transition-transform",
                        !open && "-rotate-90",
                      )}
                      aria-hidden
                    />
                    <StatusIcon status={status} />
                    {STATUS[status].label}
                    <span className="text-muted-foreground font-normal tabular-nums">
                      {rows.length}
                    </span>
                  </button>
                  <button
                    aria-label={`New issue in ${STATUS[status].label}`}
                    onClick={() => setNewTicketOpen(true)}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1"
                  >
                    <Plus className="size-3.5" aria-hidden />
                  </button>
                </h2>
                {open && (
                  <ul>
                    {rows.map((t, i) => (
                      <Row
                        key={t.id}
                        i={i}
                        t={t}
                        agent={agents.find((a) => a.id === t.assigneeAgentId)}
                        orgId={org.id}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}

function Row({ t, agent, orgId, i }: { t: Ticket; agent?: Agent; orgId: string; i: number }) {
  const fav = useUI((s) => s.favorites.includes(t.id));
  return (
    <li className="rise cv-row group/row relative" style={{ "--i": i } as React.CSSProperties}>
      <Link
        to={`/t/${t.identifier}${location.search}`}
        data-row
        className="row-slide hover:bg-accent/50 focus-visible:bg-accent border-border/60 flex h-11 items-center gap-3 border-b px-4 text-[13px] outline-none"
      >
        <PriorityIcon priority={t.priority} />
        <span className="sr-only">{PRIORITY_LABEL[t.priority]},</span>
        <span className="text-muted-foreground flex w-20 shrink-0 items-start gap-0.5 font-mono text-xs tabular-nums">
          {t.identifier}
          <SourceIcon
            linear={!!t.linearId}
            className="opacity-70 [&>*]:size-2.5"
          />
        </span>
        <StatusIcon status={t.status} />
        <span className="sr-only">{STATUS[t.status].label}:</span>
        <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
        {fav && <Star className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400" aria-label="Favorite" />}
        <LabelChips orgId={orgId} ids={t.labelIds} className="hidden lg:flex" />
        <span className="text-muted-foreground hidden w-14 text-right text-xs group-hover/row:invisible sm:inline">
          {shortDate.format(new Date(t.createdAt))}
        </span>
        <AgentAvatar agent={agent} />
        {agent && <span className="sr-only">assigned to {agent.name}</span>}
      </Link>
      <button
        aria-label={t.archived ? "Unarchive" : "Archive"}
        title={t.archived ? "Unarchive" : "Archive"}
        onClick={async () => {
          await api.patch(`/tickets/${t.id}`, { archived: !t.archived });
          queryClient.invalidateQueries({ queryKey: keys.res(orgId, "tickets") });
        }}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-12 hidden -translate-y-1/2 rounded p-1 group-hover/row:block focus-visible:block"
      >
        {t.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
      </button>
    </li>
  );
}
