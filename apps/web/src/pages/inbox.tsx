import { Lightbulb } from "lucide-react";
import { BadgeAlertIcon as CircleAlert } from "@/components/ui/badge-alert";
import { SearchIcon as Search } from "@/components/ui/search";
import { EyeIcon as Eye } from "@/components/ui/eye";
import { MailboxIcon as InboxIcon } from "@/components/ui/mailbox";
import { KeyIcon as KeyRound } from "@/components/ui/key";
import { CircleHelpIcon as MessageCircleQuestion } from "@/components/ui/circle-help";
import { WorkflowIcon as Workflow } from "@/components/ui/workflow";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { InboxItem } from "@zippy/shared";
import { AgentAvatar } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, keys, queryClient, useAgents, useInbox } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn, isTyping } from "@/lib/utils";
import { TicketPage } from "@/pages/ticket";

const KIND = {
  question: { icon: MessageCircleQuestion, label: "Question", color: "text-[#f2994a]" },
  approval: { icon: KeyRound, label: "Permission", color: "text-[#f2994a]" },
  gate: { icon: Workflow, label: "Pipeline gate", color: "text-[#f2c94c]" },
  review: { icon: Eye, label: "Review", color: "text-[#4cb782]" },
  blocked: { icon: CircleAlert, label: "Blocked", color: "text-[#eb5757]" },
  learning: { icon: Lightbulb, label: "Learning", color: "text-[#5e6ad2]" },
} as const;

const itemKey = (i: InboxItem) => i.commentId ?? `${i.kind}:${i.ticket.id}`;

/** Act on an inbox item through the same routes the issue page uses. */
async function act(item: InboxItem, optionId: string) {
  if (item.kind === "question") await api.post(`/comments/${item.commentId}/answer`, { answer: optionId });
  else if (item.kind === "approval") await api.post(`/approvals/${item.commentId}`, { optionId });
  else if (item.kind === "gate") await api.post(`/tickets/${item.ticket.id}/advance`, { verdict: optionId });
  else if (item.kind === "learning") await api.post(`/comments/${item.commentId}/learning`, { accept: optionId === "accept" });
  else if (item.kind === "review") await api.patch(`/tickets/${item.ticket.id}`, { status: "done" });
}

export function InboxPage() {
  const org = useOrg();
  const { data: items, isLoading } = useInbox(org.id);
  const { data: agents = [] } = useAgents(org.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<InboxItem["kind"] | "all">("all");
  const all = items ?? [];
  const needle = q.trim().toLowerCase();
  const list = all.filter(
    (i) => (kind === "all" || i.kind === kind) && (!needle || `${i.ticket.identifier} ${i.ticket.title} ${i.title} ${i.detail ?? ""}`.toLowerCase().includes(needle)),
  );
  const current = list.find((i) => itemKey(i) === selected) ?? list[0];

  async function run(item: InboxItem, optionId: string) {
    setBusy(itemKey(item));
    const i = list.indexOf(item);
    const next = list[i + 1] ?? list[i - 1];
    try {
      await act(item, optionId);
      if (next) setSelected(itemKey(next));
      await queryClient.invalidateQueries({ queryKey: keys.res(org.id, "inbox") });
      queryClient.invalidateQueries({ queryKey: keys.res(org.id, "tickets") });
      queryClient.invalidateQueries({ queryKey: keys.ticket(item.ticket.id) });
    } finally {
      setBusy(null);
    }
  }

  // J/K move, 1-9 pick an option of the selected item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || !current) return;
      const i = list.indexOf(current);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "j" ? 1 : -1)))];
        if (next) {
          setSelected(itemKey(next));
          document.getElementById(`inbox-${itemKey(next)}`)?.focus();
        }
      } else if (/^[1-9ar]$/.test(e.key)) {
        const opts = current.options ?? (current.kind === "review" ? [{ id: "done", label: "Mark done" }] : []);
        const yesNo = current.kind !== "question";
        const opt = e.key === "a" ? yesNo && opts.find((o) => o.primary) : e.key === "r" ? yesNo && opts.find((o) => !o.primary) : opts[Number(e.key) - 1];
        if (opt) (e.preventDefault(), run(current, opt.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex min-h-0 flex-1">
      <section aria-labelledby="inbox-h" className="flex w-full shrink-0 flex-col border-r md:w-[380px]">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
          <h1 id="inbox-h" className="text-[13px] font-medium">
            Inbox
          </h1>
          {all.length > 0 && <span className="text-muted-foreground text-xs tabular-nums">{list.length === all.length ? all.length : `${list.length}/${all.length}`}</span>}
          <span className="text-muted-foreground ml-auto hidden text-xs lg:inline">J/K move · A/R/1–9 act</span>
        </header>
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" aria-hidden />
            <Input aria-label="Search inbox" placeholder="Search inbox…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-7 text-[13px]" />
          </div>
          <select
            aria-label="Filter by type"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="bg-background h-8 rounded-md border px-2 text-[13px]"
          >
            <option value="all">All types</option>
            {Object.entries(KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <ul className="flex-1 overflow-y-auto" aria-label="Waiting on you">
          {!isLoading && !list.length && (
            <li className="text-muted-foreground grid place-items-center gap-2 p-16 text-center text-[13px]">
              <InboxIcon className="size-6 opacity-60" aria-hidden />
              {all.length ? "No matches." : "Nothing needs you. Agents are on it."}
            </li>
          )}
          <AnimatePresence initial={false}>
          {list.map((item) => {
            const k = KIND[item.kind];
            const agent = agents.find((a) => a.id === item.agentId);
            const active = current && itemKey(current) === itemKey(item);
            const options = item.options ?? (item.kind === "review" ? [{ id: "done", label: "Mark done" }] : []);
            return (
              <motion.li key={itemKey(item)} layout="position" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }} className={cn("overflow-hidden border-b", active && "bg-accent/60")}>
                <div
                  id={`inbox-${itemKey(item)}`}
                  role="button"
                  tabIndex={0}
                  aria-current={active || undefined}
                  onClick={() => setSelected(itemKey(item))}
                  onKeyDown={(e) => e.key === "Enter" && setSelected(itemKey(item))}
                  className="focus-visible:ring-ring/60 grid gap-1.5 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <k.icon className={cn("size-3.5 shrink-0", k.color)} aria-hidden />
                    <span className="text-muted-foreground">{k.label}</span>
                    <span className="text-muted-foreground font-mono text-xs tabular-nums">{item.ticket.identifier}</span>
                    <span className="text-muted-foreground ml-auto">{ago(item.createdAt)}</span>
                  </div>
                  <p className="truncate text-[13px] font-medium">{item.ticket.title}</p>
                  <p className="text-muted-foreground line-clamp-2 flex items-start gap-1.5 text-xs">
                    {agent && <AgentAvatar agent={agent} className="size-4 text-[9px]" />}
                    <span className="min-w-0">{item.title}</span>
                  </p>
                  {options.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="Actions">
                      {options.map((o, n) => (
                        <Button
                          key={o.id}
                          size="xs"
                          variant={o.primary ? "default" : "outline"}
                          disabled={busy === itemKey(item)}
                          onClick={(e) => (e.stopPropagation(), run(item, o.id))}
                          aria-keyshortcuts={active && n < 9 ? String(n + 1) : undefined}
                        >
                          {o.label}
                        </Button>
                      ))}
                      <Button size="xs" variant="ghost" asChild>
                        <Link to={`/t/${item.ticket.identifier}`} onClick={(e) => e.stopPropagation()}>
                          Open
                        </Link>
                      </Button>
                    </div>
                  )}
                </div>
              </motion.li>
            );
          })}
          </AnimatePresence>
        </ul>
      </section>
      <div className="hidden min-w-0 flex-1 md:flex">{current ? <TicketPage key={current.ticket.id} ticketId={current.ticket.id} embedded /> : null}</div>
    </div>
  );
}
