import { AlarmClock, ArrowUpRight, CornerDownLeft, Flame, Lightbulb, Maximize2, Minimize2, Reply, Undo2 } from "lucide-react";
import { BadgeAlertIcon as CircleAlert } from "@/components/ui/badge-alert";
import { SearchIcon as Search } from "@/components/ui/search";
import { EyeIcon as Eye } from "@/components/ui/eye";
import { KeyIcon as KeyRound } from "@/components/ui/key";
import { CircleHelpIcon as MessageCircleQuestion } from "@/components/ui/circle-help";
import { WorkflowIcon as Workflow } from "@/components/ui/workflow";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import type { InboxItem } from "@zippy/shared";
import { AgentAvatar, PriorityIcon } from "@/components/status";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, keys, queryClient, useAgents } from "@/lib/api";
import { SNOOZES, itemKey, useInboxState, useInboxView } from "@/lib/inbox";
import { useOrg } from "@/lib/org";
import { ago, cn, isTyping } from "@/lib/utils";
import { TicketPage } from "@/pages/ticket";

type Kind = InboxItem["kind"];
type Group = "decide" | "ship" | "blocked" | "learn";
type Filter = "all" | Group | "snoozed";

const KIND: Record<Kind, { icon: React.ComponentType<{ className?: string }>; label: string; color: string; group: Group }> = {
  approval: { icon: KeyRound, label: "Permission", color: "#f2994a", group: "decide" },
  question: { icon: MessageCircleQuestion, label: "Question", color: "#f2994a", group: "decide" },
  gate: { icon: Workflow, label: "Pipeline gate", color: "#f2c94c", group: "decide" },
  review: { icon: Eye, label: "Review", color: "#4cb782", group: "ship" },
  blocked: { icon: CircleAlert, label: "Blocked", color: "#eb5757", group: "blocked" },
  learning: { icon: Lightbulb, label: "Learning", color: "#5e6ad2", group: "learn" },
};
const GROUPS: { id: Group; label: string; hint: string; color: string }[] = [
  { id: "decide", label: "Decide now", hint: "A Zipper is paused until you answer", color: "#f2994a" },
  { id: "ship", label: "Ready to ship", hint: "Work finished, your eyes next", color: "#4cb782" },
  { id: "blocked", label: "Blocked", hint: "Needs a nudge or a decision", color: "#eb5757" },
  { id: "learn", label: "Learnings", hint: "Keep what the Zippers figured out", color: "#5e6ad2" },
];

const optionsOf = (i: InboxItem) => i.options ?? (i.kind === "review" ? [{ id: "done", label: "Mark done", primary: true }] : []);
/** Primary = "yes" (A). For questions every option is a real answer, so A/R stay off. */
const yesNo = (i: InboxItem) => i.kind !== "question";

/** Act on an inbox item through the same routes the issue page uses. */
async function act(item: InboxItem, optionId: string) {
  if (item.kind === "question") await api.post(`/comments/${item.commentId}/answer`, { answer: optionId });
  else if (item.kind === "approval") await api.post(`/approvals/${item.commentId}`, { optionId });
  else if (item.kind === "gate") await api.post(`/tickets/${item.ticket.id}/advance`, { verdict: optionId });
  else if (item.kind === "learning") await api.post(`/comments/${item.commentId}/learning`, { accept: optionId === "accept" });
  else if (item.kind === "review" && optionId === "merge") await api.post(`/tickets/${item.ticket.id}/merge`);
  else if (item.kind === "review") await api.patch(`/tickets/${item.ticket.id}`, { status: "done" });
}

/** Small progress ring: cleared today vs still waiting. */
function Ring({ done, left }: { done: number; left: number }) {
  const total = done + left;
  const pct = total ? done / total : 1;
  const r = 7.5;
  const c = 2 * Math.PI * r;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex size-5 items-center justify-center" aria-label={`${done} cleared today, ${left} waiting`}>
          <svg viewBox="0 0 20 20" className="size-5 -rotate-90">
            <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeWidth="2" className="text-foreground/10" />
            <motion.circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - pct) }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {done} cleared today · {left} waiting
      </TooltipContent>
    </Tooltip>
  );
}

function SnoozeMenu({ onPick, children }: { onPick: (until: Date) => void; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-muted-foreground text-xs">Bring back</DropdownMenuLabel>
        {SNOOZES.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => onPick(s.until())}>
            <span className="flex-1">{s.label}</span>
            {s.key && <Kbd>{s.key}</Kbd>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReplyBox({ item, onDone, big }: { item: InboxItem; onDone: () => void; big?: boolean }) {
  const org = useOrg();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const isQ = item.kind === "question";
  async function send() {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      if (isQ) await api.post(`/comments/${item.commentId}/answer`, { answer: body }, true);
      else await api.post(`/tickets/${item.ticket.id}/comments`, { body }, true);
      toast.success(isQ ? "Answered" : "Sent to the Zipper");
      queryClient.invalidateQueries({ queryKey: keys.ticket(item.ticket.id) });
      queryClient.invalidateQueries({ queryKey: keys.res(org.id, "inbox") });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }} className="overflow-hidden" onClick={(e) => e.stopPropagation()}>
      <div className={cn("grid gap-1.5 pt-2", big && "pt-3")}>
        <Textarea
          autoFocus
          rows={big ? 3 : 2}
          value={text}
          placeholder={isQ ? "Answer in your own words…" : "Tell the Zipper what to do next…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.preventDefault(), onDone());
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) (e.preventDefault(), send());
          }}
          className="resize-none text-[13px]"
        />
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> send
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> cancel
          </span>
          <Button size="xs" className="ml-auto" disabled={sending || !text.trim()} onClick={send}>
            <CornerDownLeft className="size-3" aria-hidden /> {isQ ? "Answer" : "Send"}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

/** Empty state: a drawn check, soft aurora, and the day's score. */
function Zero({ done, streak, snoozed, onShowSnoozed, filtered }: { done: number; streak: number; snoozed: number; onShowSnoozed: () => void; filtered: boolean }) {
  return (
    <div className="relative grid flex-1 place-items-center overflow-hidden p-10 text-center">
      <div aria-hidden className="aurora pointer-events-none absolute inset-0 opacity-30" style={{ "--aurora": "#4cb782" } as React.CSSProperties} />
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 26 }} className="relative grid justify-items-center gap-3">
        <svg viewBox="0 0 48 48" className="size-14" aria-hidden>
          <motion.circle cx="24" cy="24" r="21" fill="none" stroke="#4cb782" strokeWidth="2" initial={{ pathLength: 0, opacity: 0.4 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 0.8, ease: "easeOut" }} />
          <motion.path d="M15 24.5l6.5 6.5L33 18" fill="none" stroke="#4cb782" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, delay: 0.5, ease: "easeOut" }} />
        </svg>
        <p className="text-[15px] font-semibold tracking-tight">{filtered ? "Nothing here" : "Inbox zero"}</p>
        <p className="text-muted-foreground max-w-[26ch] text-[13px]">{filtered ? "Try another filter or clear the search." : done ? `You cleared ${done} today. The Zippers have the rest.` : "Nothing needs you. Zippers are on it."}</p>
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          {streak > 1 && (
            <span className="inline-flex items-center gap-1 text-[#f2994a]">
              <Flame className="size-3.5" aria-hidden /> {streak}-day streak
            </span>
          )}
          {snoozed > 0 && (
            <button onClick={onShowSnoozed} className="hover:text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline">
              <AlarmClock className="size-3.5" aria-hidden /> {snoozed} snoozed
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

type Triage = {
  busy: string | null;
  run: (item: InboxItem, optionId: string) => void;
  snooze: (item: InboxItem, until: Date | null) => void;
  reply: string | null;
  setReply: (k: string | null) => void;
};

function Row({ item, active, unread, snoozedUntil, agent, onSelect, t }: { item: InboxItem; active: boolean; unread: boolean; snoozedUntil?: string; agent?: { name: string; color: string; id?: string } | null; onSelect: () => void; t: Triage }) {
  const k = KIND[item.kind];
  const key = itemKey(item);
  const options = optionsOf(item);
  return (
    <div
      id={`inbox-${key}`}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      style={{ "--c": k.color } as React.CSSProperties}
      className={cn("group/row focus-visible:ring-ring/60 relative grid gap-1.5 py-3 pr-3 pl-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset", active ? "bg-[color-mix(in_oklab,var(--c)_7%,transparent)]" : "hover:bg-foreground/[0.03]")}
    >
      <span aria-hidden className={cn("absolute top-3 bottom-3 left-2 w-0.5 rounded-full bg-[var(--c)] transition-all duration-300", active ? "opacity-100 shadow-[0_0_10px_1px_var(--c)]" : "opacity-30 group-hover/row:opacity-60")} />
      <div className="flex items-center gap-2 text-xs">
        <k.icon className="size-3.5 shrink-0 text-[var(--c)]" aria-hidden />
        <span className="text-muted-foreground">{k.label}</span>
        <span className="text-muted-foreground font-mono tabular-nums">{item.ticket.identifier}</span>
        {item.ticket.priority !== "none" && <PriorityIcon priority={item.ticket.priority} className="size-3.5" />}
        <span className="text-muted-foreground ml-auto flex items-center gap-1.5">
          {snoozedUntil ? (
            <span className="inline-flex items-center gap-1 text-[#f2c94c]">
              <AlarmClock className="size-3" aria-hidden /> {ago(snoozedUntil)}
            </span>
          ) : (
            ago(item.createdAt)
          )}
          {unread && <span className="unread-dot size-1.5 rounded-full bg-[var(--c)]" aria-label="new" />}
        </span>
      </div>
      <p className={cn("truncate text-[13px]", unread ? "font-semibold" : "font-medium")}>{item.ticket.title}</p>
      <p className="text-muted-foreground line-clamp-2 flex items-start gap-1.5 text-xs">
        {agent && <AgentAvatar agent={agent} className="mt-px size-4 text-[9px]" />}
        <span className="min-w-0">{item.title}</span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5 pt-1" role="group" aria-label="Actions">
        {snoozedUntil ? (
          <Button size="xs" variant="outline" onClick={(e) => (e.stopPropagation(), t.snooze(item, null))}>
            <Undo2 className="size-3" aria-hidden /> Bring back
          </Button>
        ) : (
          options.map((o, n) => (
            <Button key={o.id} size="xs" variant={o.primary ? "default" : "outline"} disabled={t.busy === key} onClick={(e) => (e.stopPropagation(), t.run(item, o.id))} aria-keyshortcuts={active && n < 9 ? String(n + 1) : undefined}>
              {o.label}
            </Button>
          ))
        )}
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label="Reply" onClick={(e) => (e.stopPropagation(), t.setReply(t.reply === key ? null : key))}>
                <Reply className="size-3.5" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reply E</TooltipContent>
          </Tooltip>
          {!snoozedUntil && (
            <SnoozeMenu onPick={(d) => t.snooze(item, d)}>
              <Button size="icon-xs" variant="ghost" aria-label="Snooze">
                <AlarmClock className="size-3.5" aria-hidden />
              </Button>
            </SnoozeMenu>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-xs" variant="ghost" asChild>
                <Link to={`/t/${item.ticket.identifier}`} onClick={(e) => e.stopPropagation()} aria-label="Open issue">
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open O</TooltipContent>
          </Tooltip>
        </span>
      </div>
      <AnimatePresence>{t.reply === key && <ReplyBox key="reply" item={item} onDone={() => t.setReply(null)} />}</AnimatePresence>
    </div>
  );
}

/** Focus mode: one card at a time, the next two peeking from behind. */
function Deck({ list, current, agents, t, dir, onExit }: { list: InboxItem[]; current: InboxItem; agents: { id: string; name: string; color: string }[]; t: Triage; dir: 1 | -1; onExit: () => void }) {
  const reduce = useReducedMotion();
  const idx = list.indexOf(current);
  const k = KIND[current.kind];
  const key = itemKey(current);
  const options = optionsOf(current);
  const agent = agents.find((a) => a.id === current.agentId);
  const behind = list.slice(idx + 1, idx + 3);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" style={{ "--c": k.color } as React.CSSProperties}>
      <div aria-hidden className="aurora pointer-events-none absolute inset-0 opacity-25" style={{ "--aurora": k.color } as React.CSSProperties} />
      <div className="relative flex h-11 shrink-0 items-center gap-3 px-5">
        <span className="text-muted-foreground text-xs tabular-nums">
          {idx + 1} of {list.length}
        </span>
        <div className="bg-foreground/10 h-1 w-40 overflow-hidden rounded-full">
          <motion.div className="h-full rounded-full bg-[var(--c)]" initial={false} animate={{ width: `${((idx + 1) / list.length) * 100}%` }} transition={{ type: "spring", stiffness: 160, damping: 24 }} />
        </div>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onExit}>
          <Minimize2 className="size-3.5" aria-hidden /> List <Kbd>F</Kbd>
        </Button>
      </div>
      <div className="relative grid flex-1 place-items-center px-6 pb-16">
        <div className="relative isolate w-full max-w-xl">
          {behind.map((b, n) => (
            <motion.div key={itemKey(b)} aria-hidden layout className="bg-card border-foreground/[0.09] absolute inset-x-0 top-0 h-full rounded-2xl border shadow-[0_10px_30px_-18px_rgb(0_0_0/0.6)]" initial={false} animate={{ y: (n + 1) * 14, scale: 1 - (n + 1) * 0.04, opacity: 0.95 - n * 0.35 }} transition={{ type: "spring", stiffness: 200, damping: 26 }} style={{ zIndex: -n - 1 }} />
          ))}
          <AnimatePresence mode="popLayout" custom={dir} initial={false}>
            <motion.article
              key={key}
              aria-labelledby={`card-${key}`}
              className="glass relative flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border shadow-[0_30px_80px_-30px_color-mix(in_oklab,var(--c)_45%,transparent)]"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1, x: 0, rotate: 0 }}
              variants={{ out: (d: 1 | -1) => (reduce ? { opacity: 0 } : { opacity: 0, x: 320 * d, rotate: 6 * d, transition: { duration: 0.28, ease: [0.4, 0, 1, 1] } }) }}
              exit="out"
              transition={{ type: "spring", stiffness: 260, damping: 28 }}
            >
              <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--c),transparent)] opacity-70" />
              <header className="flex items-center gap-2 px-6 pt-5 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--c)_14%,transparent)] px-2 py-0.5 font-medium text-[var(--c)]">
                  <k.icon className="size-3.5" aria-hidden /> {k.label}
                </span>
                <Link to={`/t/${current.ticket.identifier}`} className="text-muted-foreground hover:text-foreground font-mono tabular-nums">
                  {current.ticket.identifier}
                </Link>
                {current.ticket.priority !== "none" && <PriorityIcon priority={current.ticket.priority} className="size-3.5" />}
                <span className="text-muted-foreground ml-auto">{ago(current.createdAt)}</span>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-4">
                <p className="text-muted-foreground text-[13px]">{current.ticket.title}</p>
                <h2 id={`card-${key}`} className="mt-1.5 flex items-start gap-2 text-[17px] leading-snug font-semibold tracking-tight text-balance">
                  {agent && <AgentAvatar agent={agent} className="mt-0.5 size-5 shrink-0 text-[10px]" />}
                  <span>{current.title}</span>
                </h2>
                {current.detail && (
                  <div className="md text-muted-foreground mt-3 text-[13px]">
                    <Markdown>{current.detail}</Markdown>
                  </div>
                )}
                <AnimatePresence>{t.reply === key && <ReplyBox key="reply" item={current} onDone={() => t.setReply(null)} big />}</AnimatePresence>
              </div>
              <footer className="border-foreground/[0.06] flex flex-wrap items-center gap-2 border-t px-6 py-4">
                {options.map((o, n) => (
                  <Button key={o.id} size="default" variant={o.primary ? "default" : "outline"} disabled={t.busy === key} onClick={() => t.run(current, o.id)} className={cn(o.primary && "shadow-[0_6px_20px_-8px_var(--color-primary)]")}>
                    {o.label}
                    <Kbd className={cn(o.primary && "bg-white/20 text-white")}>{yesNo(current) && o.primary ? "A" : n + 1}</Kbd>
                  </Button>
                ))}
                <span className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => t.setReply(t.reply === key ? null : key)}>
                    <Reply className="size-3.5" aria-hidden /> Reply <Kbd>E</Kbd>
                  </Button>
                  <SnoozeMenu onPick={(d) => t.snooze(current, d)}>
                    <Button size="sm" variant="ghost">
                      <AlarmClock className="size-3.5" aria-hidden /> Snooze <Kbd>S</Kbd>
                    </Button>
                  </SnoozeMenu>
                  <Button size="sm" variant="ghost" asChild>
                    <Link to={`/t/${current.ticket.identifier}`}>
                      Open <Kbd>O</Kbd>
                    </Link>
                  </Button>
                </span>
              </footer>
            </motion.article>
          </AnimatePresence>
        </div>
      </div>
      <p className="text-muted-foreground pointer-events-none absolute inset-x-0 bottom-4 hidden justify-center gap-4 text-[11px] md:flex">
        <span>
          <Kbd>J</Kbd> <Kbd>K</Kbd> move
        </span>
        <span>
          <Kbd>A</Kbd> approve
        </span>
        <span>
          <Kbd>R</Kbd> reject
        </span>
        <span>
          <Kbd>1</Kbd>–<Kbd>9</Kbd> pick
        </span>
      </p>
    </div>
  );
}

export function InboxPage() {
  const org = useOrg();
  const { items, later, isLoading, todayCleared, streak } = useInboxView(org.id);
  const { seen, snoozed, markSeen, snooze: setSnooze, bump, focus, setFocus } = useInboxState();
  const { data: agents = [] } = useAgents(org.id);
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(1); // which way the acted card leaves
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // Items first seen during this visit stay marked "new" until you leave, so the dots do not vanish under your eyes.
  const [visit] = useState(() => Date.now());
  const isNew = (i: InboxItem) => !seen[itemKey(i)] || seen[itemKey(i)]! >= visit - 1000;
  useEffect(() => {
    markSeen(items.map(itemKey));
  }, [items, markSeen]);

  const needle = q.trim().toLowerCase();
  const matches = (i: InboxItem) => !needle || `${i.ticket.identifier} ${i.ticket.title} ${i.title} ${i.detail ?? ""}`.toLowerCase().includes(needle);
  const pool = filter === "snoozed" ? later : items.filter((i) => filter === "all" || KIND[i.kind].group === filter);
  const list = pool.filter(matches);
  const current = list.find((i) => itemKey(i) === selected) ?? list[0];
  const counts = Object.fromEntries(GROUPS.map((g) => [g.id, items.filter((i) => KIND[i.kind].group === g.id).length])) as Record<Group, number>;
  const chips: { id: Filter; label: string; n: number; color?: string }[] = [{ id: "all", label: "All", n: items.length }, ...GROUPS.filter((g) => counts[g.id]).map((g) => ({ id: g.id as Filter, label: g.label, n: counts[g.id], color: g.color })), ...(later.length ? [{ id: "snoozed" as Filter, label: "Snoozed", n: later.length, color: "#f2c94c" }] : [])];

  const refresh = (ticketId: string) => {
    queryClient.invalidateQueries({ queryKey: keys.res(org.id, "inbox") });
    queryClient.invalidateQueries({ queryKey: keys.res(org.id, "tickets") });
    queryClient.invalidateQueries({ queryKey: keys.ticket(ticketId) });
  };
  const advance = (item: InboxItem) => {
    const i = list.indexOf(item);
    const next = list[i + 1] ?? list[i - 1];
    setSelected(next ? itemKey(next) : null);
  };

  const t: Triage = {
    busy,
    reply,
    setReply,
    run: async (item, optionId) => {
      const key = itemKey(item);
      setDir(optionsOf(item).find((o) => o.id === optionId)?.primary ? 1 : -1);
      setBusy(key);
      setReply(null);
      try {
        await act(item, optionId);
        bump();
        advance(item);
        await queryClient.invalidateQueries({ queryKey: keys.res(org.id, "inbox") });
        refresh(item.ticket.id);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    snooze: (item, until) => {
      setReply(null);
      setDir(1);
      if (until) advance(item);
      setSnooze(itemKey(item), until);
      toast.success(until ? `Snoozed until ${until.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Back in the inbox");
    },
  };

  // J/K move · A/R yes/no · 1-9 pick · E reply · S / ⇧S snooze · O open · F focus · Esc back
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f") return (e.preventDefault(), setFocus(!focus));
      if (e.key === "Escape") {
        if (reply) return (e.preventDefault(), setReply(null));
        if (focus) return (e.preventDefault(), setFocus(false));
        return;
      }
      if (!current) return;
      const i = list.indexOf(current);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "j" ? 1 : -1)))];
        if (next) {
          setSelected(itemKey(next));
          setReply(null);
          if (!focus) document.getElementById(`inbox-${itemKey(next)}`)?.focus();
        }
      } else if (e.key === "e") (e.preventDefault(), setReply(reply === itemKey(current) ? null : itemKey(current)));
      else if (e.key === "o") (e.preventDefault(), navigate(`/t/${current.ticket.identifier}`));
      else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        if (filter === "snoozed") return t.snooze(current, null);
        t.snooze(current, (e.key === "S" ? SNOOZES[2] : SNOOZES[0])!.until());
      } else if (/^[1-9ar]$/.test(e.key) && filter !== "snoozed") {
        const opts = optionsOf(current);
        const opt = e.key === "a" ? yesNo(current) && opts.find((o) => o.primary) : e.key === "r" ? yesNo(current) && opts.find((o) => !o.primary) : opts[Number(e.key) - 1];
        if (opt) (e.preventDefault(), t.run(current, opt.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const unread = items.filter(isNew).length;
  const grouped = filter === "snoozed" || filter !== "all" ? [{ id: filter, label: null as string | null, hint: "", items: list }] : GROUPS.map((g) => ({ ...g, items: list.filter((i) => KIND[i.kind].group === g.id) })).filter((g) => g.items.length);
  const header = (
    <header className="flex h-11 shrink-0 items-center gap-2.5 px-4">
      <h1 id="inbox-h" className="text-[13px] font-semibold tracking-tight">
        Inbox
      </h1>
      <AnimatePresence initial={false} mode="popLayout">
        {unread > 0 && (
          <motion.span key={unread} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ type: "spring", stiffness: 500, damping: 28 }} className="rounded-full bg-[color-mix(in_oklab,#f2994a_18%,transparent)] px-1.5 text-[11px] leading-5 font-semibold text-[#f2994a] tabular-nums" aria-label={`${unread} new`}>
            {unread} new
          </motion.span>
        )}
      </AnimatePresence>
      {items.length > 0 && unread === 0 && <span className="text-muted-foreground text-xs tabular-nums">{items.length}</span>}
      <span className="ml-auto flex items-center gap-2">
        {streak > 1 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[#f2994a] tabular-nums" aria-label={`${streak} day streak`}>
                <Flame className="size-3.5" aria-hidden /> {streak}
              </span>
            </TooltipTrigger>
            <TooltipContent>{streak} days in a row with a cleared inbox item</TooltipContent>
          </Tooltip>
        )}
        <Ring done={todayCleared} left={items.length} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-pressed={focus} aria-label="Focus mode" onClick={() => setFocus(!focus)}>
              {focus ? <Minimize2 className="size-3.5" aria-hidden /> : <Maximize2 className="size-3.5" aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Focus mode F</TooltipContent>
        </Tooltip>
      </span>
    </header>
  );

  if (focus && current && filter !== "snoozed") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Deck list={list} current={current} agents={agents} t={t} dir={dir} onExit={() => setFocus(false)} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <section aria-labelledby="inbox-h" className="flex w-full shrink-0 flex-col border-r md:w-[400px]">
        {header}
        <div className="grid shrink-0 gap-2 border-b px-3 pb-2">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" aria-hidden />
            <Input aria-label="Search inbox" placeholder="Search inbox…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-7 text-[13px]" />
          </div>
          <LayoutGroup id="inbox-chips">
            <div role="tablist" aria-label="Filter" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
              {chips.map((c) => {
                const on = filter === c.id;
                return (
                  <button key={c.id} role="tab" aria-selected={on} onClick={() => (setFilter(c.id), setSelected(null))} style={{ "--c": c.color ?? "var(--color-primary)" } as React.CSSProperties} className={cn("relative flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60", on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {on && <motion.span layoutId="inbox-chip" transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 450, damping: 34 }} className="absolute inset-0 rounded-full bg-[color-mix(in_oklab,var(--c)_14%,transparent)] ring-1 ring-[color-mix(in_oklab,var(--c)_30%,transparent)]" />}
                    <span className="relative">{c.label}</span>
                    <span className={cn("relative tabular-nums", on ? "text-[var(--c)]" : "opacity-70")}>{c.n}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </div>
        {!isLoading && !list.length ? (
          <Zero done={todayCleared} streak={streak} snoozed={later.length} onShowSnoozed={() => setFilter("snoozed")} filtered={!!needle || (filter !== "all" && filter !== "snoozed")} />
        ) : (
          <div className="flex-1 overflow-y-auto" aria-label="Waiting on you">
            {grouped.map((g) => (
              <section key={g.id} aria-label={g.label ?? "Items"}>
                {g.label && (
                  <h2 className="glass-bar text-muted-foreground sticky top-0 z-10 flex items-baseline gap-2 px-5 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider uppercase">
                    {g.label}
                    <span className="text-[10px] font-normal tracking-normal normal-case opacity-70">{g.hint}</span>
                  </h2>
                )}
                <ul>
                  <AnimatePresence initial={false} custom={dir}>
                    {g.items.map((item, n) => {
                      const key = itemKey(item);
                      const active = !!current && itemKey(current) === key;
                      return (
                        <motion.li key={key} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: Math.min(n, 8) * 0.03 } }} variants={{ out: (d: 1 | -1) => (reduce ? { opacity: 0 } : { opacity: 0, x: 48 * d, height: 0, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }) }} exit="out" transition={{ type: "spring", stiffness: 380, damping: 32 }} className="overflow-hidden border-b">
                          <Row item={item} active={active} unread={isNew(item)} snoozedUntil={filter === "snoozed" ? snoozed[key] : undefined} agent={agents.find((a) => a.id === item.agentId)} onSelect={() => setSelected(key)} t={t} />
                        </motion.li>
                      );
                    })}
                  </AnimatePresence>
                </ul>
              </section>
            ))}
            <p className="text-muted-foreground hidden justify-center gap-3 px-4 py-4 text-[11px] lg:flex">
              <span>
                <Kbd>J</Kbd>
                <Kbd>K</Kbd> move
              </span>
              <span>
                <Kbd>A</Kbd>
                <Kbd>R</Kbd> act
              </span>
              <span>
                <Kbd>E</Kbd> reply
              </span>
              <span>
                <Kbd>S</Kbd> snooze
              </span>
              <span>
                <Kbd>F</Kbd> focus
              </span>
            </p>
          </div>
        )}
      </section>
      <div className="hidden min-w-0 flex-1 md:flex">{current ? <TicketPage key={current.ticket.id} ticketId={current.ticket.id} embedded /> : null}</div>
    </div>
  );
}
