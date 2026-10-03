import { ErrorPage } from "@/components/error-page";
import { Archive, ArchiveRestore, ChevronDown, Columns2, PanelRight, ChevronRight, ChevronUp, GitPullRequestClosed, MoreHorizontal, Square, Star } from "lucide-react";
import { CheckIcon as Check } from "@/components/ui/check";
import { CopyIcon as Copy } from "@/components/ui/copy";
import { ExternalLinkIcon as ExternalLink } from "@/components/ui/external-link";
import { GitBranchIcon as GitBranch } from "@/components/ui/git-branch";
import { GitMergeIcon as GitMerge } from "@/components/ui/git-merge";
import { GitPullRequestIcon as GitPullRequest } from "@/components/ui/git-pull-request";
import { Link2Icon as Link2 } from "@/components/ui/link-2";
import { PlayIcon as Play } from "@/components/ui/play";
import { RefreshCWIcon as RefreshCw } from "@/components/ui/refresh-cw";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { HUMAN, type Agent, type AgentSession, type Comment, type Pipeline, type RelatedTicket, type Ticket, type ToolPayload } from "@zippy/shared";
import { Activity } from "@/components/activity";
import { Changes } from "@/components/changes";
import { Terminal } from "@/components/terminal";
import { OptionSelect } from "@/components/property-menu";
import { AssigneePicker, FoldersPicker, LabelChips, LabelsPicker, PriorityPicker, StatusPicker } from "@/components/pickers";
import { MdEditor } from "@/components/md-editor";
import { AgentAvatar, SourceIcon, StatusIcon } from "@/components/status";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, keys, useAgents, useApiMutation, usePipelines, useTicket, useTicketEvents, useTickets, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { useUI } from "@/lib/store";
import { cn, isTyping } from "@/lib/utils";
import { useOrderedTickets } from "@/pages/tickets";

const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`));

function useLinearSync(ticket: Ticket) {
  const m = useApiMutation(() => api.post<{ added: number }>(`/tickets/${ticket.id}/linear/sync`), [keys.ticket(ticket.id)]);
  return () => m.mutate(undefined, { onSuccess: ({ added }) => toast.success(added ? `${added} new Linear comment${added > 1 ? "s" : ""} synced` : "Already up to date"), onError: (e) => toast.error(e.message) });
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const tok = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

type Menu = "status" | "priority" | "assignee" | "labels" | "folders" | null;
const MENU_KEYS: Record<string, Menu> = { s: "status", p: "priority", a: "assignee", l: "labels", f: "folders" };

type Tab = "activity" | "changes" | "terminal";
const TABS: Tab[] = ["activity", "changes", "terminal"];
const SIDE_TABS: Tab[] = ["changes", "terminal"];

const Scroll = ({ children }: { children: React.ReactNode }) => <div className="h-full flex-1 overflow-x-hidden overflow-y-auto">{children}</div>;

function TabBar({ tabs, value, onChange, dot }: { tabs: Tab[]; value: Tab; onChange: (t: Tab) => void; dot: boolean }) {
  return (
    <div role="tablist" aria-label="Issue views" className="flex items-center gap-1 border-b">
      {tabs.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={value === t}
          onClick={() => onChange(t)}
          className={cn("text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent px-1.5 pb-2 text-[13px] font-medium capitalize", value === t && "border-primary text-foreground")}
        >
          {t}
          {t === "changes" && dot && <span className="bg-primary ml-1.5 inline-block size-1.5 rounded-full align-middle" aria-label="has branch changes" />}
        </button>
      ))}
    </div>
  );
}

/** Full issue view. `ticketId` + `embedded` render it inside another page (the Inbox) without list navigation keys. */
export function TicketPage({ ticketId, embedded }: { ticketId?: string; embedded?: boolean } = {}) {
  const params = useParams<{ id: string }>();
  const slug = ticketId ?? params.id;
  const org = useOrg();
  const { data: all } = useTickets(org.id);
  const id = all?.find((t) => t.identifier === slug || t.id === slug)?.id;
  const { data, isLoading } = useTicket(id);
  const { data: agents = [] } = useAgents(org.id);
  const { ordered } = useOrderedTickets();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [menu, setMenu] = useState<Menu>(null);
  const [tab, setTab] = useState<Tab>("activity");
  const [sheet, setSheet] = useState(false);
  const { split: splitPref, toggleSplit, hideProps, toggleProps } = useUI();
  const split = splitPref && !embedded;
  const layout = useDefaultLayout({ id: "ticket-split", storage: localStorage });
  useTicketEvents(id, org.id);

  // Pull fresh Linear comments and description when a linked issue opens.
  const linked = !!data?.ticket.linearId;
  useEffect(() => {
    if (linked) api.post(`/tickets/${id}/linear/sync`).catch(() => {});
  }, [id, linked]);

  const index = ordered.findIndex((t) => t.id === id);
  const go = (d: 1 | -1) => {
    const t = ordered[index + d];
    if (t) navigate(`/t/${t.identifier}${search}`);
  };

  // Linear keys: S/P/A/L/F open property menus, J/K next/prev issue, Esc back to the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const m = MENU_KEYS[e.key];
      if (m) return e.preventDefault(), setMenu(m);
      if (embedded) return;
      if (e.key === "\\") return e.preventDefault(), toggleSplit();
      if (e.key === "]") return e.preventDefault(), toggleProps();
      if (e.key === "j") go(1);
      else if (e.key === "k") go(-1);
      else if (e.key === "Escape" && !menu) navigate(`/${search}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (all && !id) return <ErrorPage code={404} compact title="Ticket not found" text={`No ticket matches "${slug}". It may have been deleted or belongs to another org.`} />;
  if (isLoading || !data) {
    return (
      <div className="grid gap-3 p-10">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  const { ticket, comments, sessions, pipeline, related, parent, children, budgetUsd } = data;
  const running = sessions.filter((s) => s.running).map((s) => s.agentId);
  const hasBranch = ticket.folders.some((f) => f.branch);
  const side = tab === "terminal" ? "terminal" : "changes";
  const head = (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      {!embedded && <title>{`${ticket.identifier} ${ticket.title} | Zippy - Zipper coworkers for your tickets`}</title>}
      <TitleEditor ticket={ticket} />
      <DescriptionEditor ticket={ticket} />
    </div>
  );
  const activity = <Activity ticketId={ticket.id} comments={comments} agents={agents} running={running} />;
  const changes = <Changes ticket={ticket} comments={comments} agents={agents} />;
  const terminal = <Terminal comments={comments} />;
  const sidePane = side === "terminal" ? terminal : changes;
  const main = (
    <article className="grid min-w-0 grid-cols-1 gap-8 px-6 py-8">
      {head}
      {activity}
    </article>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-[13px]">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <Link to={`/${search}`} className="text-muted-foreground hover:text-foreground shrink-0">
            Issues
          </Link>
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-mono font-medium">{ticket.identifier}</span>
          <span className="truncate">{ticket.title}</span>
        </nav>
        <FavoriteButton id={ticket.id} />
        <TicketMenu ticket={ticket} />
        <div className="ml-auto flex items-center gap-2">
          <RunControls ticket={ticket} agents={agents} running={running} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button aria-label="Toggle split view" aria-pressed={split} onClick={toggleSplit} className={cn("hover:bg-accent text-muted-foreground hover:text-foreground hidden size-7 items-center justify-center rounded-md border", !embedded && "lg:flex", split && "bg-accent text-foreground")}>
                <Columns2 className="size-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>Split view (\)</TooltipContent>
          </Tooltip>
          <button aria-label="Properties" onClick={() => setSheet(true)} className="hover:bg-accent text-muted-foreground flex size-8 items-center justify-center rounded-md border lg:hidden">
            <PanelRight className="size-4" aria-hidden />
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button aria-label="Toggle properties" aria-pressed={!hideProps} onClick={toggleProps} className={cn("hover:bg-accent text-muted-foreground hover:text-foreground hidden size-7 items-center justify-center rounded-md border lg:flex", !hideProps && "bg-accent text-foreground")}>
                <PanelRight className="size-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>Properties (])</TooltipContent>
          </Tooltip>
          {index >= 0 && !embedded && (
            <div className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
              <span aria-label={`Issue ${index + 1} of ${ordered.length}`}>
                {index + 1} / {ordered.length}
              </span>
              <NavBtn label="Next issue (J)" disabled={index >= ordered.length - 1} onClick={() => go(1)} icon={ChevronDown} />
              <NavBtn label="Previous issue (K)" disabled={index <= 0} onClick={() => go(-1)} icon={ChevronUp} />
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {split ? (
            <Group orientation="horizontal" id="ticket-split" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="min-h-0 flex-1">
              <Panel id="main" minSize="30%">
                <Scroll>{main}</Scroll>
              </Panel>
              <Separator className="bg-border hover:bg-primary focus-visible:bg-primary w-px outline-none transition-colors after:absolute after:inset-y-0 after:-inset-x-1 relative" />
              <Panel id="side" minSize="25%">
                <Scroll>
                  <div className="grid gap-4 p-4">
                    <TabBar tabs={SIDE_TABS} value={side} onChange={setTab} dot={hasBranch} />
                    {sidePane}
                  </div>
                </Scroll>
              </Panel>
            </Group>
          ) : (
            <Scroll>
              <article className="mx-auto grid max-w-[760px] grid-cols-1 gap-8 px-6 py-10 md:px-12">
                {head}
                <div className="grid min-w-0 grid-cols-1 gap-4">
                  <TabBar tabs={TABS} value={tab} onChange={setTab} dot={hasBranch} />
                  <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
                    {tab === "activity" ? activity : tab === "changes" ? changes : terminal}
                  </motion.div>
                </div>
              </article>
            </Scroll>
          )}
          {pipeline && ticket.stageId && ticket.status === "needs_input" && <GateBar ticket={ticket} pipeline={pipeline} />}
        </div>
        {(!hideProps || sheet) && <Properties sheet={sheet} onClose={() => setSheet(false)} comments={comments} ticket={ticket} agents={agents} sessions={sessions} pipeline={pipeline} related={related} parent={parent} subIssues={children} budgetUsd={budgetUsd} menu={menu} setMenu={setMenu} />}
      </div>
    </div>
  );
}

function NavBtn({ label, disabled, onClick, icon: Icon }: { label: string; disabled: boolean; onClick: () => void; icon: typeof ChevronUp }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button aria-label={label} disabled={disabled} onClick={onClick} className="hover:bg-accent hover:text-foreground flex size-7 items-center justify-center rounded-md border disabled:opacity-40">
          <Icon className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function FavoriteButton({ id }: { id: string }) {
  const { favorites, toggleFavorite } = useUI();
  const on = favorites.includes(id);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button aria-label={on ? "Remove from favorites" : "Add to favorites"} aria-pressed={on} onClick={() => toggleFavorite(id)} className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 items-center justify-center rounded-md">
          <Star className={cn("size-4", on && "fill-yellow-400 text-yellow-400")} aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{on ? "Unfavorite" : "Favorite"}</TooltipContent>
    </Tooltip>
  );
}

function TicketMenu({ ticket }: { ticket: Ticket }) {
  const sync = useLinearSync(ticket);
  const org = useOrg();
  const navigate = useNavigate();
  const archive = useApiMutation(() => api.patch(`/tickets/${ticket.id}`, { archived: !ticket.archived }), [keys.ticket(ticket.id), keys.res(org.id, "tickets")]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Issue actions" className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 items-center justify-center rounded-md">
        <MoreHorizontal className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-52">
        <DropdownMenuItem onSelect={() => copy(location.href, "Link")}>
          <Link2 aria-hidden /> Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copy(ticket.identifier, "ID")}>
          <Copy aria-hidden /> Copy ID
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => archive.mutate(undefined, { onSuccess: () => { if (!ticket.archived) navigate("/?tab=all"); } })}>
          {ticket.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />} {ticket.archived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
        {ticket.folders[0]?.branch && (
          <DropdownMenuItem onSelect={() => copy(ticket.folders[0]!.branch!, "Branch name")}>
            <GitBranch aria-hidden /> Copy branch name
          </DropdownMenuItem>
        )}
        {ticket.linearUrl && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={sync}
            >
              <RefreshCw aria-hidden /> Sync from Linear
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={ticket.linearUrl} target="_blank" rel="noreferrer" data-external>
                <ExternalLink aria-hidden /> Open in Linear
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunControls({ ticket, agents, running }: { ticket: Ticket; agents: Agent[]; running: string[] }) {
  const run = useApiMutation(() => api.post(`/tickets/${ticket.id}/run`, {}));
  const stop = useApiMutation((agentId: string) => api.post(`/tickets/${ticket.id}/cancel`, { agentId }));
  const assignee = agents.find((a) => a.id === ticket.assigneeAgentId);
  return (
    <>
      {running.map((agentId) => (
        <Button key={agentId} size="xs" variant="outline" onClick={() => stop.mutate(agentId)}>
          <Square className="size-2.5 fill-current" aria-hidden /> Stop {agents.find((a) => a.id === agentId)?.name}
        </Button>
      ))}
      {assignee && !running.includes(assignee.id) && (
        <Button size="xs" variant="outline" onClick={() => run.mutate(undefined)} disabled={run.isPending}>
          <Play className="size-2.5 fill-current" aria-hidden /> Run {assignee.name}
        </Button>
      )}
    </>
  );
}

function TitleEditor({ ticket }: { ticket: Ticket }) {
  const save = useApiMutation((title: string) => api.patch(`/tickets/${ticket.id}`, { title }), [keys.ticket(ticket.id)]);
  return (
    <h1>
      <textarea
        aria-label="Issue title"
        rows={1}
        defaultValue={ticket.title}
        key={ticket.title}
        onBlur={(e) => e.target.value.trim() && e.target.value !== ticket.title && save.mutate(e.target.value.trim())}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
        className="w-full resize-none bg-transparent text-2xl leading-tight font-semibold tracking-[-0.01em] outline-none [field-sizing:content]"
      />
    </h1>
  );
}

function DescriptionEditor({ ticket }: { ticket: Ticket }) {
  const save = useApiMutation((body: string) => api.patch(`/tickets/${ticket.id}`, { body }), [keys.ticket(ticket.id)]);
  return <MdEditor boxed={false} label="Description" placeholder="Add description…" value={ticket.body} onBlur={(md) => md !== ticket.body && save.mutate(md)} className="hover:bg-accent/30 focus-visible:bg-accent/30 -mx-2 rounded-md px-2 py-1 text-[15px] leading-relaxed" />;
}

/** Shown when a pipeline stage waits on the user. */
function GateBar({ ticket, pipeline }: { ticket: Ticket; pipeline: Pipeline }) {
  const [note, setNote] = useState("");
  const advance = useApiMutation((verdict: "pass" | "fail") => api.post(`/tickets/${ticket.id}/advance`, { verdict, note: note || undefined }));
  const stage = pipeline.stages.find((s) => s.id === ticket.stageId);
  return (
    <div role="region" aria-label="Pipeline decision" className="shrink-0 border-t bg-[#f2994a]/5 px-6 py-3">
      <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-2">
        <span className="text-[13px]">
          <span className="font-medium">{stage?.name}</span> waits for you.
        </span>
        <input
          aria-label="Note for the Zipper (optional)"
          placeholder="Optional note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="bg-background focus-visible:ring-ring/50 h-8 min-w-48 flex-1 rounded-md border px-2 text-[13px] outline-none focus-visible:ring-2"
        />
        <Button size="sm" variant="outline" onClick={() => advance.mutate("fail")} disabled={advance.isPending}>
          Redo stage
        </Button>
        <Button size="sm" onClick={() => advance.mutate("pass")} disabled={advance.isPending}>
          Approve & continue
        </Button>
      </div>
    </div>
  );
}

const TOOL_BY_KIND: Record<string, string> = { execute: "Bash", read: "Read", edit: "Edit", search: "Search", fetch: "Fetch", delete: "Delete", move: "Move", think: "Think" };

/** Tool comments carry the call's title ("Read src/a.ts"); group by tool, not by arguments. */
const toolName = (p: ToolPayload) => (/^mcp__|^\S+$/.test(p.title) ? p.title : (p.kind && TOOL_BY_KIND[p.kind]) || p.title.split(" ")[0]!);

function ToolCalls({ comments }: { comments: Comment[] }) {
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>();
  for (const c of comments) if (c.kind === "tool") counts.set(toolName(c.payload as ToolPayload), (counts.get(toolName(c.payload as ToolPayload)) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs tabular-nums transition">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden /> {total} tool call{total === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-1 grid gap-0.5 text-xs">
          {[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => (
            <li key={name} className="flex items-center justify-between gap-3 pl-4">
              <span className="truncate font-mono" title={name}>
                {name.replace(/^mcp__/, "").replace("__", " · ")}
              </span>
              <span className="text-muted-foreground tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PanelSection({ title, children, action, card }: { title: string; children: React.ReactNode; action?: React.ReactNode; card?: boolean }) {
  return (
    <section aria-label={title} className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <h2 className="text-muted-foreground/80 flex h-6 items-center justify-between px-2 font-mono text-[10px] font-medium tracking-[0.14em] uppercase">
        {title}
        {action}
      </h2>
      {card ? <div className="border-foreground/[0.07] bg-foreground/[0.03] grid gap-px rounded-xl border p-1">{children}</div> : children}
    </section>
  );
}

const PR_ICON = { OPEN: [GitPullRequest, "text-[#4cb782]"], MERGED: [GitMerge, "text-[#8b5cf6]"], CLOSED: [GitPullRequestClosed, "text-[#eb5757]"] } as const;

function TicketLinks({ title, items, search }: { title: string; items: RelatedTicket[]; search: string }) {
  if (!items.length) return null;
  return (
    <PanelSection title={title}>
      <ul className="grid grid-cols-[minmax(0,1fr)]">
        {items.map((r) => (
          <li key={r.id}>
            <Link to={`/t/${r.identifier}${search}`} className="hover:bg-primary/[0.08] flex h-8 items-center gap-2 rounded-lg px-2 transition-colors">
              <StatusIcon status={r.status} />
              <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">{r.identifier}</span>
              <span className="truncate">{r.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}

function CopyBtn({ label, icon: Icon, onClick }: { label: string; icon: typeof Copy; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button aria-label={label} onClick={onClick} className="border-foreground/[0.07] bg-foreground/[0.04] text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary flex size-8 items-center justify-center rounded-xl border transition-all hover:-translate-y-px">
          <Icon className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Properties(props: {
  comments: Comment[];
  ticket: Ticket;
  agents: Agent[];
  sessions: AgentSession[];
  pipeline: Pipeline | null;
  related: RelatedTicket[];
  parent: RelatedTicket | null;
  subIssues: RelatedTicket[];
  budgetUsd: number | null;
  menu: Menu;
  setMenu: (m: Menu) => void;
  sheet: boolean;
  onClose: () => void;
}) {
  const { sheet, onClose, comments, ticket, agents, sessions, pipeline, related, parent, subIssues, budgetUsd, menu, setMenu } = props;
  const spent = sessions.reduce((n, s) => n + s.costUsd, 0);
  const tokIn = sessions.reduce((n, s) => n + s.tokensIn, 0);
  const tokOut = sessions.reduce((n, s) => n + s.tokensOut, 0);
  const tokCacheRead = sessions.reduce((n, s) => n + s.tokensCacheRead, 0);
  const tokCacheWrite = sessions.reduce((n, s) => n + s.tokensCacheWrite, 0);
  const org = useOrg();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { search } = useLocation();
  const patch = useApiMutation((v: Partial<Ticket> & { workspaceIds?: string[] }) => api.patch(`/tickets/${ticket.id}`, v), [keys.ticket(ticket.id), keys.res(org.id, "tickets")]);
  const ctl = (m: Exclude<Menu, null>) => ({ open: menu === m, onOpenChange: (o: boolean) => setMenu(o ? m : null) });
  const diffs = ticket.folders.filter((f) => f.branch || f.prUrl);
  const sync = useLinearSync(ticket);

  return (
    <>
    {sheet && <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm lg:hidden" onClick={onClose} aria-hidden />}
    <aside className={cn("border-foreground/[0.07] bg-card/40 relative m-2 ml-0 hidden w-[300px] shrink-0 flex-col gap-5 overflow-x-hidden overflow-y-auto rounded-2xl border px-3 py-4 text-[13px] shadow-[inset_0_1px_0_0_rgb(255_255_255/0.05)] lg:flex", sheet && "glass-pop sheet-up max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-50 max-lg:m-0 max-lg:flex max-lg:max-h-[82dvh] max-lg:w-auto max-lg:rounded-b-none max-lg:rounded-t-3xl max-lg:pb-[calc(1rem+env(safe-area-inset-bottom))]")} aria-label="Issue properties">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(100%_100%_at_50%_0%,color-mix(in_oklab,var(--color-primary)_14%,transparent),transparent)]" />
      <div className="relative -mb-1 flex items-center justify-end gap-1.5">
        <span className="border-foreground/[0.07] bg-foreground/[0.04] mr-auto flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px]">
          <SourceIcon linear={!!ticket.linearId} /> {ticket.identifier}
        </span>
        <CopyBtn label="Copy link" icon={Link2} onClick={() => copy(location.href, "Link")} />
        <CopyBtn label="Copy ID" icon={Copy} onClick={() => copy(ticket.identifier, "ID")} />
        {ticket.linearUrl && <CopyBtn label="Sync from Linear" icon={RefreshCw} onClick={sync} />}
        {ticket.folders[0]?.branch && <CopyBtn label="Copy branch name" icon={GitBranch} onClick={() => copy(ticket.folders[0]!.branch!, "Branch name")} />}
      </div>
      {diffs.length > 0 && (
        <PanelSection title="Diffs">
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {diffs.map((f) => {
              const ws = workspaces.find((w) => w.id === f.workspaceId);
              const [Icon, color] = f.prUrl ? PR_ICON[(f.prState as keyof typeof PR_ICON) ?? "OPEN"] ?? PR_ICON.OPEN : [GitBranch, "text-muted-foreground"];
              const label = f.prUrl ? `[${ticket.identifier}] ${f.prTitle ?? ws?.name}` : `${ws?.name}: ${f.branch}`;
              return (
                <li key={f.workspaceId}>
                  {f.prUrl ? (
                    <a href={f.prUrl} target="_blank" rel="noreferrer" className="hover:bg-primary/[0.08] flex h-8 items-center gap-2 rounded-lg px-2 transition-colors" title={label}>
                      <Icon className={cn("size-4 shrink-0", color)} aria-hidden /> <span className="truncate">{label}</span>
                      <span className="sr-only">({f.prState?.toLowerCase() ?? "open"} pull request, opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="text-muted-foreground flex h-8 items-center gap-2 px-2" title={label}>
                      <Icon className={cn("size-4 shrink-0", color)} aria-hidden /> <span className="truncate font-mono text-xs">{label}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </PanelSection>
      )}

      <PanelSection title="Properties" card>
        <StatusPicker {...ctl("status")} value={ticket.status} onChange={(status) => patch.mutate({ status })} />
        <PriorityPicker {...ctl("priority")} value={ticket.priority} onChange={(priority) => patch.mutate({ priority })} />
        <AssigneePicker {...ctl("assignee")} orgId={org.id} value={ticket.assigneeHuman ? HUMAN : ticket.assigneeAgentId} onChange={(v) => patch.mutate({ assigneeAgentId: v === HUMAN ? null : v, assigneeHuman: v === HUMAN })} />
        <FoldersPicker {...ctl("folders")} orgId={org.id} value={ticket.folders.map((f) => f.workspaceId)} onChange={(workspaceIds) => patch.mutate({ workspaceIds })} />
      </PanelSection>

      <PanelSection title="Labels">
        <div className="flex flex-wrap items-center gap-1 px-2">
          <LabelChips orgId={org.id} ids={ticket.labelIds} />
          <LabelsPicker {...ctl("labels")} orgId={org.id} value={ticket.labelIds} onChange={(labelIds) => patch.mutate({ labelIds })} />
        </div>
      </PanelSection>

      <PipelineSection ticket={ticket} pipeline={pipeline} agents={agents} />

      <TicketLinks title="Parent" items={parent ? [parent] : []} search={search} />
      <TicketLinks title="Sub-issues" items={subIssues} search={search} />
      <TicketLinks title="Related" items={related.filter((r) => r.id !== parent?.id && !subIssues.some((c) => c.id === r.id))} search={search} />

      {(spent > 0 || tokIn + tokOut + tokCacheRead + tokCacheWrite > 0 || comments.some((c) => c.kind === "tool") || budgetUsd) && (
        <PanelSection title="Cost">
          <div className="grid gap-1.5 px-2">
            <p className="tabular-nums">
              <span className="font-mono text-lg font-semibold">{usd(spent)}</span>
              {budgetUsd ? <span className="text-muted-foreground"> of {usd(budgetUsd)} budget</span> : <span className="text-muted-foreground"> spent</span>}
            </p>
            {budgetUsd && (
              <div
                role="meter"
                aria-label="Budget used"
                aria-valuemin={0}
                aria-valuemax={budgetUsd}
                aria-valuenow={Number(spent.toFixed(2))}
                className="bg-foreground/[0.08] h-1.5 overflow-hidden rounded-full"
              >
                <div className={cn("h-full rounded-full", spent >= budgetUsd ? "bg-[#eb5757]" : spent >= budgetUsd * 0.8 ? "bg-[#f2994a]" : "from-primary bg-gradient-to-r to-cyan-400 shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_60%,transparent)]")} style={{ width: `${Math.min(100, (spent / budgetUsd) * 100)}%` }} />
              </div>
            )}
            <p className="text-muted-foreground flex flex-wrap gap-x-3 text-xs tabular-nums" title={`${tokIn.toLocaleString()} new input, ${tokCacheRead.toLocaleString()} cache read, ${tokCacheWrite.toLocaleString()} cache write, ${tokOut.toLocaleString()} output`}>
              <span>{tok(tokIn)} in</span>
              <span>{tok(tokCacheRead)} cached</span>
              <span>{tok(tokCacheWrite)} cache write</span>
              <span>{tok(tokOut)} out</span>
            </p>
            <ToolCalls comments={comments} />
          </div>
        </PanelSection>
      )}

      {sessions.length > 0 && (
        <PanelSection title="Zippers">
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {sessions.map((s) => {
              const a = agents.find((x) => x.id === s.agentId);
              return (
                <li key={s.agentId} className="flex h-8 items-center gap-2 px-2">
                  <AgentAvatar agent={a} running={s.running} />
                  <span className="flex-1 truncate">{a?.name}</span>
                  <span className="text-muted-foreground text-xs tabular-nums" title={`${tok(s.tokensIn)} in, ${tok(s.tokensCacheRead)} cached, ${tok(s.tokensCacheWrite)} cache write, ${tok(s.tokensOut)} out`}>
                    {usd(s.costUsd)}
                  </span>
                  <span className="sr-only">{s.running ? "working" : "idle"}</span>
                </li>
              );
            })}
          </ul>
        </PanelSection>
      )}
    </aside>
    </>
  );
}

function PipelineSection({ ticket, pipeline, agents }: { ticket: Ticket; pipeline: Pipeline | null; agents: Agent[] }) {
  const org = useOrg();
  const { data: pipelines = [] } = usePipelines(org.id);
  const [choice, setChoice] = useState<string>();
  const start = useApiMutation((pipelineId: string) => api.post(`/tickets/${ticket.id}/pipeline`, { pipelineId }), [keys.ticket(ticket.id)]);
  const chosen = choice ?? pipelines[0]?.id;

  if (!pipeline || !ticket.stageId) {
    if (!pipelines.length) return null;
    return (
      <PanelSection title={pipeline ? `${pipeline.name} pipeline finished` : "Pipeline"}>
        <div className="flex gap-2 px-2">
          <OptionSelect size="sm" label="Pipeline" value={chosen ?? ""} onChange={setChoice} options={pipelines.map((p) => ({ value: p.id, label: p.name }))} className="min-w-0 flex-1" />
          <Button size="sm" variant="outline" onClick={() => chosen && start.mutate(chosen)} disabled={!chosen || start.isPending || !ticket.folders.length}>
            <Play className="size-3 fill-current" aria-hidden /> {pipeline ? "Rerun" : "Start"}
          </Button>
        </div>
        {!ticket.folders.length && <p className="text-muted-foreground px-2 text-xs">Add a working folder first (F).</p>}
      </PanelSection>
    );
  }

  const currentPos = pipeline.stages.find((s) => s.id === ticket.stageId)?.position ?? -1;
  return (
    <PanelSection title={`${pipeline.name} pipeline`} action={ticket.loopCount > 0 ? <span>fix loop {ticket.loopCount}/{pipeline.maxLoops}</span> : undefined}>
      <ol className="grid grid-cols-[minmax(0,1fr)]">
        {pipeline.stages.map((s) => {
          const state = s.position < currentPos ? "done" : s.position === currentPos ? "current" : "todo";
          return (
            <li key={s.id} aria-current={state === "current" ? "step" : undefined} className={cn("flex h-8 items-center gap-2 rounded-lg px-2", state === "current" && "bg-[linear-gradient(90deg,color-mix(in_oklab,#f2c94c_16%,transparent),transparent)] ring-1 ring-[#f2c94c]/25")}>
              <span
                aria-hidden
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                  state === "done" && "border-[#4cb782] bg-[#4cb782] text-white",
                  state === "current" && "border-[#f2c94c]",
                )}
              >
                {state === "done" ? <Check className="size-2.5" /> : state === "current" ? <span className="size-1.5 animate-pulse rounded-full bg-[#f2c94c]" /> : null}
              </span>
              <span className={cn("flex-1 truncate", state === "todo" && "text-muted-foreground")}>{s.name}</span>
              <span className="sr-only">({state})</span>
              <AgentAvatar agent={agents.find((x) => x.id === s.agentId)} className="size-4 text-[9px]" />
            </li>
          );
        })}
      </ol>
    </PanelSection>
  );
}
