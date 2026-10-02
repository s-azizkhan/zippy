import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useAgents, useTickets, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { useUI } from "@/lib/store";
import { cn, isTyping } from "@/lib/utils";

const TABS = [
  { id: "all", label: "All issues", statuses: null },
  {
    id: "active",
    label: "Active",
    statuses: ["needs_input", "in_review", "in_progress", "blocked", "todo"],
  },
  { id: "backlog", label: "Backlog", statuses: ["backlog"] },
  { id: "linear", label: "Linear", statuses: null },
  { id: "files", label: "Files", statuses: null },
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
  const tab =
    TABS.find(
      (t) =>
        t.id === params.get("tab") &&
        (t.id !== "linear" || org.linearConnected) &&
        (t.id !== "files" || !!folder),
    ) ?? TABS[0];
  const ordered = useMemo(() => {
    let rows = tickets ?? [];
    if (folder)
      rows = rows.filter((t) =>
        t.folders.some((f) => f.workspaceId === folder),
      );
    if (view === "inbox") rows = rows.filter((t) => INBOX.includes(t.status));
    else if (tab.statuses)
      rows = rows.filter((t) =>
        (tab.statuses as readonly string[]).includes(t.status),
      );
    return STATUS_ORDER.flatMap((s) => rows.filter((t) => t.status === s));
  }, [tickets, folder, view, tab]);
  return { ordered, isLoading, folder, view, tab };
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
  const { ordered, isLoading, folder, view, tab } = useOrderedTickets();
  const { data: agents = [] } = useAgents(org.id);
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const setNewTicketOpen = useUI((s) => s.setNewTicketOpen);
  const [params, setParams] = useSearchParams();
  const [closed, setClosed] = useState<Set<TicketStatus>>(new Set());
  useRowKeys();

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
                    if (t.id === "all") next.delete("tab");
                    else next.set("tab", t.id);
                    setParams(next);
                  }}
                  className={cn(
                    "text-muted-foreground hover:text-foreground h-6 rounded-md border border-transparent px-2 text-xs font-medium",
                    tab.id === t.id &&
                      "bg-accent text-foreground border-border",
                  )}
                >
                  {t.label}
                </button>
              ),
            )}
          </div>
        )}
      </header>

      {tab.id === "files" && folder ? (
        <FileBrowser id={folder} />
      ) : tab.id === "linear" && view !== "inbox" ? (
        <LinearIssues />
      ) : (
        <div className="flex-1 overflow-y-auto">
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
                    {rows.map((t) => (
                      <Row
                        key={t.id}
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
        </div>
      )}
    </div>
  );
}

function Row({ t, agent, orgId }: { t: Ticket; agent?: Agent; orgId: string }) {
  return (
    <li>
      <Link
        to={`/t/${t.identifier}${location.search}`}
        data-row
        className="hover:bg-accent/50 focus-visible:bg-accent border-border/60 flex h-11 items-center gap-3 border-b px-4 text-[13px] outline-none"
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
        <LabelChips orgId={orgId} ids={t.labelIds} className="hidden lg:flex" />
        <span className="text-muted-foreground hidden w-14 text-right text-xs sm:inline">
          {shortDate.format(new Date(t.createdAt))}
        </span>
        <AgentAvatar agent={agent} />
        {agent && <span className="sr-only">assigned to {agent.name}</span>}
      </Link>
    </li>
  );
}
