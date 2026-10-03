import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, MessageSquarePlus, Square, Ticket as TicketIcon } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useNavigate, useParams } from "react-router";
import { Activity, Composer, MentionInput } from "@/components/activity";
import { ErrorPage } from "@/components/error-page";
import { FoldersPicker } from "@/components/pickers";
import { AgentAvatar } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, keys, useAgents, useApiMutation, useChats, useTicket, useTicketEvents, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn } from "@/lib/utils";

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const org = useOrg();
  const [archived, setArchived] = useState(false);
  const { data: chats = [] } = useChats(org.id, archived);
  const { data: agents = [] } = useAgents(org.id);
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 md:flex" aria-label="Chats">
        <Link to="/chat" className={cn("hover:bg-accent flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] font-medium", !id && "bg-accent")}>
          <MessageSquarePlus className="size-4" aria-hidden /> New chat
        </Link>
        <button aria-pressed={archived} onClick={() => setArchived(!archived)} className={cn("text-muted-foreground hover:bg-accent hover:text-foreground flex h-8 items-center gap-2 rounded-lg px-2 text-[13px]", archived && "bg-accent text-foreground")}>
          <Archive className="size-4" aria-hidden /> {archived ? "Archived chats" : "View archived"}
        </button>
        {archived && !chats.length && <p className="text-muted-foreground px-2 py-1 text-xs">No archived chats.</p>}
        {chats.map((c) => (
          <Link key={c.id} to={`/chat/${c.id}`} className={cn("hover:bg-accent flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]", c.id === id && "bg-accent")}>
            <AgentAvatar agent={agents.find((a) => a.id === c.assigneeAgentId)} className="size-5 text-[10px]" />
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="text-muted-foreground shrink-0 text-[11px]">{ago(c.createdAt)}</span>
          </Link>
        ))}
      </aside>
      {id ? <Thread key={id} id={id} /> : <NewChat />}
    </div>
  );
}

/** Mouse drag-to-scroll for a horizontal row (touch already swipes) plus which sides still have content. A drag swallows the click that ends it. */
function useDragScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef({ x: 0, left: 0, down: false, moved: false });
  const [edge, setEdge] = useState({ l: false, r: false });
  const update = () => {
    const el = ref.current;
    if (el) setEdge({ l: el.scrollLeft > 4, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [dep]);
  return {
    ref,
    edge,
    by: (left: number) => ref.current?.scrollBy({ left, behavior: "smooth" }),
    props: {
      onScroll: update,
      onMouseDown: (e: React.MouseEvent<HTMLElement>) => (st.current = { x: e.clientX, left: e.currentTarget.scrollLeft, down: true, moved: false }),
      onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
        const d = st.current;
        if (!d.down) return;
        if (Math.abs(e.clientX - d.x) > 5) d.moved = true;
        e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
      },
      onMouseUp: () => (st.current.down = false),
      onMouseLeave: () => (st.current.down = false),
      onClickCapture: (e: React.MouseEvent) => st.current.moved && (e.stopPropagation(), (st.current.moved = false)),
    },
  };
}

const STARTERS = ["Walk me through how this repo is structured", "What changed in the last few commits?", "Help me scope a new feature", "Hunt for likely bugs in recent changes"];

function NewChat() {
  const org = useOrg();
  const navigate = useNavigate();
  const { data: agents = [] } = useAgents(org.id);
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const [agentId, setAgentId] = useState<string>();
  const [folders, setFolders] = useState<string[]>();
  const [draft, setDraft] = useState("");
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const workspaceIds = folders ?? (workspaces[0] ? [workspaces[0].id] : []);
  const start = useApiMutation((message: string) => api.post<{ id: string }>(`/orgs/${org.id}/chats`, { agentId: agent?.id, workspaceIds, message }, true), [keys.res(org.id, "chats")]);
  const go = (t: string, done: () => void = () => {}) => start.mutate(t, { onSuccess: (c) => (done(), navigate(`/chat/${c.id}`)) });
  const drag = useDragScroll(agents.length);
  const [hour] = useState(() => new Date().getHours());
  const hello = hour < 5 ? "Burning the midnight oil" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = org.profile.name.split(" ")[0];
  const ready = !!agent && workspaceIds.length > 0;

  return (
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
      <div aria-hidden className="aurora pointer-events-none absolute -inset-10" style={{ "--aurora": agent?.color } as React.CSSProperties} />
      <div className="relative mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center gap-7 px-6">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid gap-1">
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
            <img src="/favicon.svg" alt="" className="size-5" /> {hello}{name && `, ${name}`}
          </p>
          <h1 className="from-foreground to-foreground/55 bg-gradient-to-br bg-clip-text text-4xl leading-tight font-semibold tracking-[-0.03em] text-transparent">What do you want to talk through?</h1>
        </motion.div>

        <div className="relative -mx-6 -my-3">
        <div
          role="radiogroup"
          aria-label="Zipper"
          ref={drag.ref}
          {...drag.props}
          style={{ maskImage: `linear-gradient(to right, ${drag.edge.l ? "transparent 0, black 64px" : "black 0"}, ${drag.edge.r ? "black calc(100% - 64px), transparent 100%" : "black 100%"})` }}
          className="flex cursor-grab snap-x snap-proximity scroll-px-6 gap-2 overflow-x-auto px-6 py-3 select-none active:cursor-grabbing [scrollbar-width:none] [&>*]:snap-start"
        >
          {agents.map((a, i) => (
            <motion.button
              key={a.id}
              role="radio"
              aria-checked={a.id === agent?.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i }}
              onClick={() => setAgentId(a.id)}
              style={{ "--c": a.color } as React.CSSProperties}
              className={cn("bg-card/60 flex shrink-0 items-center gap-2.5 rounded-2xl border py-2 pr-4 pl-2 text-left backdrop-blur transition-all hover:-translate-y-0.5", a.id === agent?.id ? "border-[var(--c)] shadow-[0_6px_24px_-8px_var(--c)] ring-1 ring-[var(--c)]" : "opacity-70 hover:opacity-100")}
            >
              <AgentAvatar agent={a} className="size-8" />
              <span className="grid leading-tight">
                <span className="text-[13px] font-semibold">{a.name}</span>
                <span className="text-muted-foreground font-mono text-[11px]">@{a.handle}</span>
              </span>
            </motion.button>
          ))}
        </div>
        {(["l", "r"] as const).map((side) => (
          <button key={side} tabIndex={-1} aria-label={side === "l" ? "Scroll left" : "Scroll right"} onClick={() => drag.by(side === "l" ? -240 : 240)} className={cn("bg-card hover:bg-accent absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full border shadow-md transition-opacity", side === "l" ? "left-3" : "right-3", !drag.edge[side] && "pointer-events-none opacity-0")}>
            {side === "l" ? <ChevronLeft className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
          </button>
        ))}
        </div>

        <div className="bg-card/80 rounded-3xl border px-5 py-4 shadow-xl backdrop-blur">
          {ready ? (
            <MentionInput large key={draft} initial={draft} folders={workspaces} agents={agents} placeholder={`Ask ${agent.name} anything… ⌘↵ to send`} pending={start.isPending} onSend={go} />
          ) : (
            <p className="text-muted-foreground text-[13px]">Add a working folder and a Zipper first.</p>
          )}
          <div className="mt-3 flex items-center gap-2 border-t pt-3">
            <span className="text-muted-foreground text-xs">Looking at</span>
            <FoldersPicker chip orgId={org.id} value={workspaceIds} onChange={setFolders} />
            <span className="text-muted-foreground ml-auto hidden text-xs sm:block">Read-only · can turn this into a ticket</span>
          </div>
        </div>

        {ready && (
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((t, i) => (
              <motion.button key={t} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 + 0.07 * i }} onClick={() => setDraft(t)} className="bg-card/50 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/[0.08] rounded-full border px-3.5 py-1.5 text-[13px] backdrop-blur transition-colors">
                {t}
              </motion.button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const org = useOrg();
  const navigate = useNavigate();
  const { data, isLoading, error } = useTicket(id);
  const { data: agents = [] } = useAgents(org.id);
  const end = useRef<HTMLDivElement>(null);
  useTicketEvents(id, org.id);
  const n = data?.comments.length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [n]);
  const ticket = data?.ticket;
  const busy = !!data?.sessions.some((s) => s.running);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) toast.success("Zipper finished replying");
    wasBusy.current = busy;
  }, [busy]);
  const makeTicket = useApiMutation(() => api.post(`/tickets/${id}/comments`, { body: "Draft a ticket from this conversation for me to review." }, true));
  const stop = useApiMutation((agentId: string) => api.post(`/tickets/${id}/cancel`, { agentId }));
  const folders = useApiMutation((workspaceIds: string[]) => api.patch(`/tickets/${id}`, { workspaceIds }, true), [keys.ticket(id)]);
  const archive = useApiMutation((archived: boolean) => api.patch(`/tickets/${id}`, { archived }, true).then(() => void toast.success(archived ? "Chat archived" : "Chat unarchived")), [keys.res(org.id, "chats"), keys.res(org.id, "chats-archived"), keys.ticket(id)]);

  if (error) return <ErrorPage code={404} compact title="Chat not found" text="It may have been archived or belongs to another org." />;
  if (isLoading || !data || !ticket) return <div className="grid flex-1 content-start gap-3 p-10"><Skeleton className="h-7 w-1/3" /><Skeleton className="h-24" /></div>;
  const running = data.sessions.filter((s) => s.running).map((s) => s.agentId);
  const agent = agents.find((a) => a.id === ticket.assigneeAgentId);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-[13px]">
        <AgentAvatar agent={agent} className="size-5 text-[10px]" />
        <span className="font-medium">{agent?.name}</span>
        <span className="text-muted-foreground min-w-0 truncate">{ticket.title}</span>
        <div className="ml-auto flex items-center gap-2">
          {!ticket.archived && <FoldersPicker chip orgId={org.id} value={ticket.folders.map((f) => f.workspaceId)} onChange={(workspaceIds) => workspaceIds.length && folders.mutate(workspaceIds)} />}
          {running.map((agentId) => (
            <Button key={agentId} size="xs" variant="outline" onClick={() => stop.mutate(agentId)}>
              <Square className="size-2.5 fill-current" aria-hidden /> Stop
            </Button>
          ))}
          <Button size="xs" variant="outline" onClick={() => makeTicket.mutate(undefined)} disabled={makeTicket.isPending || running.length > 0 || ticket.archived}>
            <TicketIcon className="size-3.5" aria-hidden /> Draft ticket
          </Button>
          {ticket.archived ? (
            <Button size="xs" variant="outline" onClick={() => archive.mutate(false)}>
              <ArchiveRestore className="size-3.5" aria-hidden /> Unarchive
            </Button>
          ) : (
            <Button size="xs" variant="ghost" aria-label="Archive chat" onClick={() => archive.mutate(true, { onSuccess: () => navigate("/chat") })}>
              <Archive className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </header>
      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 py-6">
          <Activity chat ticketId={id} comments={data.comments} agents={agents} running={running} />
          <div ref={end} />
        </div>
      </div>
      <div className="shrink-0 px-6 pb-4">
        <div className={cn("mx-auto max-w-[760px] rounded-2xl p-[1.5px] transition-[background] duration-500", running.length > 0 && "working-ring")}>
          {ticket.archived ? (
            <p className="text-muted-foreground bg-card rounded-2xl border px-4 py-3 text-center text-[13px]">This chat is archived. Unarchive it to send new messages.</p>
          ) : (
            <Composer chat ticketId={id} agents={agents} running={running} />
          )}
        </div>
      </div>
    </div>
  );
}
