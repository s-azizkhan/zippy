import { ChevronRight, Loader2 } from "lucide-react";
import { ArrowRightIcon as ArrowRight } from "@/components/ui/arrow-right";
import { ArrowUpIcon as ArrowUp } from "@/components/ui/arrow-up";
import { CheckIcon as Check } from "@/components/ui/check";
import { BadgeAlertIcon as CircleAlert } from "@/components/ui/badge-alert";
import { ExternalLinkIcon as ExternalLink } from "@/components/ui/external-link";
import { GitPullRequestIcon as GitPullRequest } from "@/components/ui/git-pull-request";
import { WorkflowIcon as Workflow } from "@/components/ui/workflow";
import { WrenchIcon as Wrench } from "@/components/ui/wrench";
import { XIcon as X } from "@/components/ui/x";
import { Children, useId, useMemo, useRef, useState, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
import Markdown from "react-markdown";
import type { Editor } from "@tiptap/react";
import { MdEditor } from "@/components/md-editor";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import type {
  Agent,
  ApprovalPayload,
  Comment,
  HandoffPayload,
  LearningPayload,
  PlanPayload,
  PrPayload,
  QuestionPayload,
  StagePayload,
  StatusPayload,
  TestPayload,
  Ticket,
  ToolPayload,
} from "@zippy/shared";
import { TestResult } from "@/components/changes";
import { AgentAvatar, STATUS, StatusIcon, UserAvatar } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { api, useApiMutation } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn } from "@/lib/utils";

/** Image in markdown: click opens a full-size preview. */
function MdImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <button type="button" onClick={(e) => (e.stopPropagation(), setOpen(true))} aria-label={`Preview image: ${alt || "image"}`} className="focus-visible:ring-ring/60 block max-w-full rounded-md outline-none focus-visible:ring-2">
        <img src={src} alt={alt ?? ""} loading="lazy" className="max-h-96 max-w-full rounded-md border object-contain" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-auto max-w-[95vw] p-2 sm:max-w-[95vw]">
          <DialogTitle className="sr-only">{alt || "Image"}</DialogTitle>
          <img src={src} alt={alt ?? ""} className="max-h-[85vh] max-w-full rounded object-contain" />
          <a href={src} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground px-1 text-xs">
            Open original
          </a>
        </DialogContent>
      </Dialog>
    </>
  );
}

const MENTION_RE = /(@[a-z][a-z0-9-]+|\b[A-Z][A-Z0-9]{1,9}-\d+\b)/g;

/** Highlight @agent and TICKET-ID in text nodes. */
const hl = (children: ReactNode): ReactNode =>
  Children.map(children, (ch) =>
    typeof ch !== "string"
      ? ch
      : ch.split(MENTION_RE).map((part, i) =>
          i % 2 ? (
            <Link key={i} to={part[0] === "@" ? `/zippers/${part.slice(1)}` : `/t/${part}`} className="bg-primary/10 text-primary hover:bg-primary/20 rounded px-1 font-medium no-underline">
              {part}
            </Link>
          ) : (
            part
          ),
        ),
  );

export const md = (text: string) => (
  <div className="md">
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ src, alt }) => <MdImage src={typeof src === "string" ? src : undefined} alt={alt} />,
        p: ({ children }) => <p>{hl(children)}</p>,
        li: ({ children }) => <li>{hl(children)}</li>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        code: ({ className, children }) => {
          const text = String(children);
          const lang = /language-(\S+)/.exec(className ?? "")?.[1];
          if (!lang && !text.includes("\n")) return <code>{children}</code>; // inline
          const html = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(text).value;
          return <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />;
        },
      }}
    >
      {text}
    </Markdown>
  </div>
);

const EVENT_KINDS = new Set(["status", "stage", "tool"]);

type Item = { type: "event"; c: Comment } | { type: "tools"; items: Comment[] } | { type: "card"; c: Comment; replies: Comment[] };

/** Top-level timeline: cards with their replies, event lines, and runs of tool calls folded together. */
function build(comments: Comment[]): Item[] {
  const replies = new Map<string, Comment[]>();
  for (const c of comments) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c]);
  const items: Item[] = [];
  for (const c of comments) {
    if (c.parentId) continue;
    const last = items.at(-1);
    if (c.kind === "tool") {
      if (last?.type === "tools") last.items.push(c);
      else items.push({ type: "tools", items: [c] });
    } else if (EVENT_KINDS.has(c.kind)) items.push({ type: "event", c });
    else items.push({ type: "card", c, replies: replies.get(c.id) ?? [] });
  }
  return items;
}

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="text-muted-foreground">
      {ago(iso)}
    </time>
  );
}

export function Activity({ ticketId, comments, agents, running }: { ticketId: string; comments: Comment[]; agents: Agent[]; running: string[] }) {
  const items = useMemo(() => build(comments), [comments]);
  const agent = (id: string | null) => agents.find((a) => a.id === id);
  const announce = useMemo(() => {
    const c = comments.findLast((x) => x.kind === "status" || x.kind === "approval" || x.kind === "question");
    if (!c) return "";
    if (c.kind === "status") return `Status: ${STATUS[(c.payload as StatusPayload).to as Ticket["status"]].label}`;
    return `${agent(c.agentId)?.name ?? "Zipper"} needs your input`;
  }, [comments]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section aria-labelledby="activity-h" className="grid min-w-0 grid-cols-1 gap-3">
      <h2 id="activity-h" className="text-[14px] font-semibold">
        Activity
      </h2>
      <ol className="grid grid-cols-1 gap-3">
        {items.map((it) => (
          <li key={it.type === "tools" ? it.items[0]!.id : it.c.id}>
            {it.type === "event" ? (
              <EventLine c={it.c} agent={agent(it.c.agentId)} />
            ) : it.type === "tools" ? (
              <ToolRun items={it.items} agent={agent(it.items[0]!.agentId)} />
            ) : (
              it.c.kind === "test" ? (
                <TestResult p={it.c.payload as TestPayload} iso={it.c.createdAt} />
              ) : (
                <Card c={it.c} replies={it.replies} agent={agent(it.c.agentId)} agents={agents} ticketId={ticketId} />
              )
            )}
          </li>
        ))}
      </ol>
      {running.length > 0 && (
        <p className="text-muted-foreground flex items-center gap-2 pl-1 text-xs">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {running.map((id) => agent(id)?.name).join(", ")} working…
        </p>
      )}
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      <Composer ticketId={ticketId} agents={agents} />
    </section>
  );
}

function EventLine({ c, agent }: { c: Comment; agent?: Agent }) {
  if (c.kind === "status") {
    const p = c.payload as StatusPayload;
    const to = p.to as Ticket["status"];
    return (
      <p className="text-muted-foreground flex items-center gap-2 pl-1.5 text-xs">
        <StatusIcon status={to} className="size-3.5" />
        <span>
          <span className="text-foreground/90 font-medium">Zippy</span> moved from {STATUS[p.from as Ticket["status"]]?.label ?? "—"} to{" "}
          <span className="text-foreground/90 font-medium">{STATUS[to].label}</span> · <Time iso={c.createdAt} />
        </span>
      </p>
    );
  }
  const p = c.payload as StagePayload;
  return (
    <p className="text-muted-foreground flex items-center gap-2 pl-1.5 text-xs">
      <Workflow className="size-3.5" aria-hidden />
      <span>
        Stage <span className="text-foreground/90 font-medium">{p.name}</span> started for <span className="text-foreground/90 font-medium">{agent?.name}</span>
        {p.loop > 0 && ` (fix loop ${p.loop})`} · <Time iso={c.createdAt} />
      </span>
    </p>
  );
}

function ToolRun({ items, agent }: { items: Comment[]; agent?: Agent }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((c) => (c.payload as ToolPayload).status === "failed").length;
  const active = items.some((c) => !["completed", "failed"].includes((c.payload as ToolPayload).status ?? ""));
  return (
    <div className="pl-1.5 text-xs">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="text-muted-foreground hover:text-foreground flex items-center gap-2">
        {active ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Wrench className="size-3.5" aria-hidden />}
        <span>
          <span className="text-foreground/90 font-medium">{agent?.name}</span> ran {items.length} tool call{items.length > 1 && "s"}
          {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
        </span>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open && (
        <ul className="border-border mt-2 ml-1.5 grid gap-1 border-l pl-4">
          {items.map((c) => {
            const p = c.payload as ToolPayload;
            return (
              <li key={c.id}>
                <details>
                  <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-2">
                    {p.status === "completed" ? (
                      <Check className="size-3 text-[#4cb782]" aria-label="completed" />
                    ) : p.status === "failed" ? (
                      <X className="text-destructive size-3" aria-label="failed" />
                    ) : (
                      <Loader2 className="size-3 animate-spin" aria-label="running" />
                    )}
                    <span className="truncate font-mono">{p.title}</span>
                  </summary>
                  {p.output && <pre className="bg-muted mt-1.5 max-h-64 overflow-auto rounded-md p-2.5 font-mono text-[11px] whitespace-pre-wrap">{p.output}</pre>}
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CardHeader({ agent, author: linearAuthor, iso, children }: { agent?: Agent; author?: string; iso: string; children?: React.ReactNode }) {
  const org = useOrg();
  const { name, linearUser } = org.profile;
  // A Linear comment by you shows as "You", linked to your Linear profile.
  const mine = !!linearAuthor && [name, linearUser].some((n) => n && n.toLowerCase() === linearAuthor.toLowerCase());
  const author = mine ? undefined : linearAuthor;
  const profileUrl = mine && org.linearWorkspace && linearUser ? `https://linear.app/${org.linearWorkspace}/profiles/${linearUser}` : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      {agent ? <AgentAvatar agent={agent} /> : <UserAvatar name={author} />}
      <span className="font-medium">{agent ? agent.name : profileUrl ? <a href={profileUrl} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">You</a> : (author ?? "You")}</span>
      {agent && <span className="text-muted-foreground text-xs">via Zippy</span>}
      {linearAuthor && <span className="text-muted-foreground text-xs">via Linear</span>}
      {children}
      <span className="text-xs">
        <Time iso={iso} />
      </span>
    </div>
  );
}

function Card({ c, replies, agent, agents, ticketId }: { c: Comment; replies: Comment[]; agent?: Agent; agents: Agent[]; ticketId: string }) {
  const tone =
    c.kind === "handoff"
      ? (c.payload as HandoffPayload).verdict === "pass"
        ? "border-[#4cb782]/30"
        : "border-[#eb5757]/35"
      : (c.kind === "question" && !(c.payload as QuestionPayload).answer) || (c.kind === "approval" && (c.payload as ApprovalPayload).decision == null)
        ? "border-[#f2994a]/50"
        : c.kind === "error"
          ? "border-destructive/40"
          : "";
  return (
    <article className={cn("bg-card overflow-hidden rounded-lg border", tone)} aria-label={`Comment by ${agent?.name ?? (c.payload as { author?: string }).author ?? "you"}`}>
      <div className="grid min-w-0 grid-cols-1 gap-2 px-4 py-3">
        <CardBody c={c} agent={agent} />
      </div>
      {replies.length > 0 && (
        <ol className="grid gap-3 border-t px-4 py-3">
          {replies.map((r) => {
            const ra = agents.find((a) => a.id === r.agentId);
            return (
              <li key={r.id} className="grid gap-1.5">
                <CardHeader agent={ra} author={(r.payload as { author?: string }).author} iso={r.createdAt} />
                <div className="pl-7 text-[14px]">{md((r.payload as { text?: string }).text ?? "")}</div>
              </li>
            );
          })}
        </ol>
      )}
      <ReplyBox ticketId={ticketId} parentId={c.id} agents={agents} />
    </article>
  );
}

function CardBody({ c, agent }: { c: Comment; agent?: Agent }) {
  if (c.kind === "handoff") {
    const p = c.payload as HandoffPayload;
    const pass = p.verdict === "pass";
    return (
      <>
        <CardHeader agent={agent} iso={c.createdAt}>
          <span className={cn("rounded px-1.5 text-[11px] font-semibold uppercase", pass ? "bg-[#4cb782]/15 text-[#4cb782]" : "bg-[#eb5757]/15 text-[#eb5757]")}>
            {p.stage} {p.verdict}
          </span>
          <ArrowRight className="text-muted-foreground size-3.5" aria-label="handed to" />
          <span className="font-medium">{p.next}</span>
        </CardHeader>
        <div className="pl-7 text-[14px]">{md(p.summary)}</div>
        {p.notes && (
          <details className="pl-7">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">Handoff notes</summary>
            <div className="mt-2 text-[13px]">{md(p.notes)}</div>
          </details>
        )}
      </>
    );
  }
  if (c.kind === "question") return <QuestionBody c={c} agent={agent} />;
  if (c.kind === "approval") return <ApprovalBody c={c} agent={agent} />;
  if (c.kind === "learning") return <LearningBody c={c} agent={agent} />;
  if (c.kind === "pr") {
    const p = c.payload as PrPayload;
    return (
      <>
        <CardHeader agent={agent} iso={c.createdAt} />
        <a href={p.url} target="_blank" rel="noreferrer" className="hover:bg-accent/60 ml-7 flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
          <GitPullRequest className="size-4 text-[#4cb782]" aria-hidden /> <span className="flex-1 truncate">{p.title}</span>
          <ExternalLink className="text-muted-foreground size-3.5" aria-label="opens in a new tab" />
        </a>
      </>
    );
  }
  if (c.kind === "plan") {
    const p = c.payload as PlanPayload;
    return (
      <>
        <CardHeader agent={agent} iso={c.createdAt}>
          <span className="text-muted-foreground text-xs">updated the plan</span>
        </CardHeader>
        <ul className="grid gap-1 pl-7 text-[13px]">
          {p.entries.map((e, i) => (
            <li key={i} className="flex items-start gap-2">
              <span
                aria-hidden
                className={cn("mt-1 size-3 shrink-0 rounded-full border", e.status === "completed" && "border-[#4cb782] bg-[#4cb782]", e.status === "in_progress" && "border-[#f2c94c]")}
              />
              <span className={cn(e.status === "completed" && "text-muted-foreground line-through")}>{e.content}</span>
              <span className="sr-only">({e.status})</span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  if (c.kind === "error") {
    return (
      <div role="alert" className="flex items-start gap-2 text-[13px]">
        <CircleAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex-1">{md((c.payload as { text: string }).text)}</div>
      </div>
    );
  }
  const p = c.payload as { text?: string; author?: string };
  return (
    <>
      <CardHeader agent={agent} author={p.author} iso={c.createdAt} />
      <div className="pl-7 text-[14px] leading-relaxed">{md(p.text ?? "")}</div>
    </>
  );
}

function QuestionBody({ c, agent }: { c: Comment; agent?: Agent }) {
  const p = c.payload as QuestionPayload;
  const answer = useApiMutation((a: string) => api.post(`/comments/${c.id}/answer`, { answer: a }));
  return (
    <>
      <CardHeader agent={agent} iso={c.createdAt}>
        <span className="text-xs text-[#f2994a]">asks you</span>
      </CardHeader>
      <div className="pl-7 text-[14px]">{md(p.question)}</div>
      <div className="flex flex-wrap gap-2 pl-7" role="group" aria-label="Answers">
        {p.answer ? (
          <p className="text-muted-foreground text-xs">
            You answered <span className="text-foreground font-medium">{p.answer}</span>
          </p>
        ) : (
          p.options.map((o) => (
            <Button key={o} size="sm" variant={o === p.recommended ? "default" : "outline"} onClick={() => answer.mutate(o)} disabled={answer.isPending}>
              {o}
              {o === p.recommended && <span className="text-[10px] opacity-80">recommended</span>}
            </Button>
          ))
        )}
      </div>
    </>
  );
}

function LearningBody({ c, agent }: { c: Comment; agent?: Agent }) {
  const p = c.payload as LearningPayload;
  const decide = useApiMutation((accept: boolean) => api.post(`/comments/${c.id}/learning`, { accept }));
  return (
    <>
      <CardHeader agent={agent} iso={c.createdAt}>
        <span className="text-xs text-[#5e6ad2]">proposes a learning for {p.workspaceId ? "this folder" : "the org"}</span>
      </CardHeader>
      <div className="pl-7 text-[14px]">{md(p.text)}</div>
      <div className="flex flex-wrap gap-2 pl-7" role="group" aria-label="Learning">
        {p.status ? (
          <p className="text-muted-foreground text-xs">{p.status === "accepted" ? "Added to context" : "Dismissed"}</p>
        ) : (
          <>
            <Button size="sm" onClick={() => decide.mutate(true)} disabled={decide.isPending}>
              Add to context
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide.mutate(false)} disabled={decide.isPending}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function ApprovalBody({ c, agent }: { c: Comment; agent?: Agent }) {
  const p = c.payload as ApprovalPayload;
  const decide = useApiMutation((optionId: string | null) => api.post(`/approvals/${c.id}`, { optionId }));
  const decided = p.decision != null;
  return (
    <>
      <CardHeader agent={agent} iso={c.createdAt}>
        <span className="text-xs text-[#f2994a]">wants permission</span>
      </CardHeader>
      <pre className="bg-muted ml-7 overflow-auto rounded-md p-2.5 font-mono text-xs whitespace-pre-wrap">{p.title}</pre>
      <div className="flex flex-wrap gap-2 pl-7" role="group" aria-label="Permission">
        {decided ? (
          <p className="text-muted-foreground text-xs">Decision: {p.options.find((o) => o.optionId === p.decision)?.name ?? "Cancelled"}</p>
        ) : (
          p.options.map((o) => (
            <Button key={o.optionId} size="sm" variant={o.kind.startsWith("allow") ? "default" : "outline"} onClick={() => decide.mutate(o.optionId)} disabled={decide.isPending}>
              {o.name}
            </Button>
          ))
        )}
      </div>
    </>
  );
}

/** Rendered markdown editor with @agent autocomplete. ⌘↵ sends. */
export function MentionInput({
  agents,
  onSend,
  placeholder,
  compact,
  pending,
}: {
  agents: Agent[];
  onSend: (text: string, done: () => void) => void;
  placeholder: string;
  compact?: boolean;
  pending?: boolean;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<{ q: string } | null>(null);
  const [active, setActive] = useState(0);
  const editor = useRef<Editor | null>(null);
  const listId = useId();
  const matches = mention ? agents.filter((a) => a.handle.startsWith(mention.q) || a.name.toLowerCase().startsWith(mention.q)) : [];
  const expanded = !compact || focused || !!text;

  function onChange(md: string) {
    setText(md);
    const { $from } = editor.current!.state.selection;
    const m = /(?:^|\s)@([a-z-]*)$/.exec($from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc"));
    setMention(m ? { q: m[1]! } : null);
    setActive(0);
  }
  function pick(a: Agent) {
    const ed = editor.current;
    if (!ed || !mention) return;
    const to = ed.state.selection.from;
    ed.chain().focus().deleteRange({ from: to - mention.q.length - 1, to }).insertContent(`@${a.handle} `).run();
    setMention(null);
  }
  const send = () => text.trim() && onSend(text, () => setText(""));

  return (
    <div className="relative" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      {matches.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Zippers" className="bg-popover absolute bottom-full z-20 mb-2 w-64 overflow-hidden rounded-lg border p-1 shadow-lg">
          {matches.map((a, i) => (
            <li
              key={a.id}
              id={`${listId}-${a.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => (e.preventDefault(), pick(a))}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]", i === active && "bg-accent")}
            >
              <AgentAvatar agent={a} /> {a.name} <span className="text-muted-foreground ml-auto text-xs">@{a.handle}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <div className={cn("min-w-0 flex-1", expanded ? "max-h-64 min-h-12 overflow-y-auto" : "max-h-8 overflow-hidden")}>
          <MdEditor
            boxed={false}
            value={text}
            label={placeholder}
            placeholder={placeholder}
            onEditor={(e) => (editor.current = e)}
            onChange={onChange}
            onKeyDown={(e) => {
              if (matches.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
                  return true;
                }
                if (e.key === "Enter" || e.key === "Tab") return pick(matches[active]!), true;
                if (e.key === "Escape") return setMention(null), true;
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return send(), true;
            }}
            className="text-[14px] leading-relaxed"
          />
        </div>
        <button
          onClick={send}
          disabled={!text.trim() || pending}
          aria-label="Send (Command Enter)"
          className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full disabled:bg-muted disabled:text-muted-foreground"
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function ReplyBox({ ticketId, parentId, agents }: { ticketId: string; parentId: string; agents: Agent[] }) {
  const send = useApiMutation((body: string) => api.post(`/tickets/${ticketId}/comments`, { body, parentId }));
  return (
    <div className="border-t px-4 py-2.5">
      <MentionInput compact agents={agents} placeholder="Leave a reply…" pending={send.isPending} onSend={(t, done) => send.mutate(t, { onSuccess: done })} />
    </div>
  );
}

function Composer({ ticketId, agents }: { ticketId: string; agents: Agent[] }) {
  const send = useApiMutation((body: string) => api.post(`/tickets/${ticketId}/comments`, { body }));
  return (
    <div className="bg-card mt-1 rounded-lg border px-4 py-3">
      <MentionInput agents={agents} placeholder="Leave a comment… @mention a Zipper to put it to work" pending={send.isPending} onSend={(t, done) => send.mutate(t, { onSuccess: done })} />
    </div>
  );
}
