import { useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { FlaskIcon as FlaskConical } from "@/components/ui/flask";
import { FolderGit2Icon as FolderGit2 } from "@/components/ui/folder-git-2";
import { MessageSquarePlusIcon as MessageSquarePlus } from "@/components/ui/message-square-plus";
import { RefreshCWIcon as RefreshCw } from "@/components/ui/refresh-cw";
import { XIcon as X } from "@/components/ui/x";
import hljs from "highlight.js/lib/common";
import type { Agent, Comment, DiffFile, TestPayload, Ticket } from "@zippy/shared";
import { MentionInput } from "@/components/activity";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useApiMutation, useDiff, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn } from "@/lib/utils";

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)/;
const HEADER = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/;

function newLineNumbers(lines: string[]) {
  let n = 0;
  return lines.map((l) => {
    const h = HUNK.exec(l);
    if (h) n = +h[1]! - 1;
    else if (!l.startsWith("-")) n++;
    return n;
  });
}

const LANG: Record<string, string> = { tsx: "typescript", jsx: "javascript", mjs: "javascript", cjs: "javascript", vue: "xml", svelte: "xml", php: "php", tf: "ini", env: "ini" };

/** Highlighter language from file extension; undefined = plain. Per-line, so multi-line strings/comments won't carry across lines. */
export function langOf(path: string) {
  const ext = path.split(".").pop()!.toLowerCase();
  const l = LANG[ext] ?? ext;
  return hljs.getLanguage(l) ? l : undefined;
}

type Ctx = { ticketId: string; agents: Agent[]; folder: string; branch: string | null };

/** Review comment box: posts to the ticket timeline, quoting `quote` under `label`. @mention routes it to agents. */
function CommentBox({ ctx, label, quote, onDone }: { ctx: Ctx; label: string; quote?: string; onDone: () => void }) {
  const send = useApiMutation((body: string) => api.post(`/tickets/${ctx.ticketId}/comments`, { body }));
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // ticket page's Esc = back to list
      onDone();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onDone]);
  return (
    <div className="bg-card relative border-y px-3 py-2 font-sans whitespace-normal">
      <Button size="xs" variant="ghost" className="absolute top-2.5 right-11 z-10" onClick={onDone} aria-label="Cancel comment (Esc)" title="Cancel (Esc)">
        <X className="size-3" aria-hidden />
      </Button>
      <MentionInput
        compact
        agents={ctx.agents}
        placeholder={`Comment on ${label} · @mention an agent`}
        pending={send.isPending}
        onSend={(t, done) =>
          send.mutate(`**${ctx.folder}${ctx.branch ? ` (${ctx.branch})` : ""} · ${label}**\n${quote ? `\`\`\`\n${quote}\n\`\`\`\n` : ""}${t}`, {
            onSuccess: () => {
              done();
              onDone();
            },
          })
        }
      />
    </div>
  );
}

function Patch({ patch, path, ctx }: { patch: string; path: string; ctx: Ctx }) {
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, [dragging]);
  const lang = langOf(path);
  const lines = useMemo(() => patch.split("\n").filter((l) => !HEADER.test(l)), [patch]);
  const html = useMemo(() => lines.map((l) => (lang && !HUNK.test(l) && l.length > 1 ? hljs.highlight(l.slice(1), { language: lang, ignoreIllegals: true }).value : null)), [lines, lang]);
  if (!patch) return <p className="text-muted-foreground px-3 py-2 text-xs">New untracked file, or binary. No text diff.</p>;
  const nums = newLineNumbers(lines);
  const lo = sel ? Math.min(sel.from, sel.to) : -1;
  const hi = sel ? Math.max(sel.from, sel.to) : -1;
  const picked = sel ? lines.slice(lo, hi + 1).filter((l) => !HUNK.test(l)) : [];
  const label = lo === hi ? (lines[lo]?.startsWith("-") ? `${path} (removed)` : `${path}:${nums[lo]}`) : `${path}:${nums[lo]}-${nums[hi]}`;
  return (
    <pre className="py-1 font-mono text-[12px] leading-5" aria-label="Diff">
      {lines.map((l, i) => {
        const hunk = HUNK.test(l);
        return (
          <div key={i}>
            <div
              onMouseEnter={() => dragging && setSel((c) => c && { ...c, to: i })}
              className={cn(
                "group/line relative px-3 pr-9 break-words whitespace-pre-wrap",
                l.startsWith("+") && "bg-[#4cb782]/12 text-[#7fd1a8]",
                l.startsWith("-") && "bg-[#eb5757]/12 text-[#f19a9a]",
                hunk && "text-muted-foreground bg-[#5e6ad2]/10",
                dragging && "select-none",
                i >= lo && i <= hi && "ring-1 ring-[#5e6ad2] ring-inset",
              )}
            >
              <span className="sr-only">{l.startsWith("+") ? "added: " : l.startsWith("-") ? "removed: " : ""}</span>
              {html[i] != null ? (
                <>
                  {l[0]}
                  <span dangerouslySetInnerHTML={{ __html: html[i] }} />
                </>
              ) : (
                l || " "
              )}
              {!hunk && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (e.shiftKey && sel) return setSel({ from: sel.from, to: i });
                    setSel({ from: i, to: i });
                    setDragging(true);
                  }}
                  onClick={(e) => e.detail === 0 && setSel({ from: i, to: i })}
                  aria-label={`Comment on line ${nums[i]}`}
                  title="Comment · drag or shift-click to select a range"
                  className="bg-card text-foreground absolute top-0.5 right-2 hidden rounded border p-0.5 group-hover/line:block focus-visible:block"
                >
                  <MessageSquarePlus className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            {i === hi && <CommentBox ctx={ctx} label={label} quote={picked.join("\n")} onDone={() => setSel(null)} />}
          </div>
        );
      })}
    </pre>
  );
}

function FileRow({ f, ctx }: { f: DiffFile; ctx: Ctx }) {
  const [commenting, setCommenting] = useState(false);
  return (
    <div className="border-b last:border-b-0">
      <details className="group">
        <summary className="hover:bg-accent/50 flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-[13px]">
          <span className="text-muted-foreground text-xs transition-transform group-open:rotate-90" aria-hidden>
            ▸
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
            {f.path}
          </span>
          {f.risky && (
            <span className="flex items-center gap-1 rounded bg-[#f2994a]/15 px-1.5 text-[11px] font-medium text-[#f2994a]">
              <ShieldAlert className="size-3" aria-hidden /> Protected
            </span>
          )}
          <span className="text-xs tabular-nums">
            <span className="text-[#4cb782]">+{f.additions}</span> <span className="text-[#eb5757]">−{f.deletions}</span>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setCommenting(!commenting);
            }}
            aria-label={`Comment on file ${f.path}`}
            title="Comment on file"
            className="text-muted-foreground hover:text-foreground rounded p-0.5"
          >
            <MessageSquarePlus className="size-3.5" aria-hidden />
          </button>
        </summary>
        <div className="bg-background/60 border-t">
          <Patch patch={f.patch} path={f.path} ctx={ctx} />
        </div>
      </details>
      {commenting && <CommentBox ctx={ctx} label={f.path} onDone={() => setCommenting(false)} />}
    </div>
  );
}

export function TestResult({ p, iso }: { p: TestPayload; iso: string }) {
  return (
    <details className={cn("rounded-lg border", p.ok ? "border-[#4cb782]/30" : "border-[#eb5757]/40")}>
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-[13px]">
        <FlaskConical className={cn("size-4", p.ok ? "text-[#4cb782]" : "text-[#eb5757]")} aria-hidden />
        <span className="font-medium">{p.folder}</span>
        <span className={p.ok ? "text-[#4cb782]" : "text-[#eb5757]"}>{p.ok ? "tests passed" : "tests failed"}</span>
        <span className="text-muted-foreground ml-auto text-xs">
          {(p.durationMs / 1000).toFixed(1)}s · {ago(iso)}
        </span>
      </summary>
      <pre className="bg-muted/40 max-h-80 overflow-auto border-t p-3 font-mono text-[11px] whitespace-pre-wrap">
        <span className="text-muted-foreground">$ {p.command}</span>
        {"\n"}
        {p.output || "(no output)"}
      </pre>
    </details>
  );
}

/** Verify view: what the agents changed in each folder, plus the latest test run per folder. */
export function Changes({ ticket, comments, agents }: { ticket: Ticket; comments: Comment[]; agents: Agent[] }) {
  const org = useOrg();
  const [showMerged, setShowMerged] = useState(false);
  const { data: diffs, isFetching, refetch } = useDiff(ticket.id, true, showMerged);
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const run = useApiMutation(() => api.post(`/tickets/${ticket.id}/tests`));
  const testable = ticket.folders.some((f) => workspaces.find((w) => w.id === f.workspaceId)?.testCmd);
  const latestTests = [...new Map(comments.filter((c) => c.kind === "test").map((c) => [(c.payload as TestPayload).folder, c])).values()];

  return (
    <section aria-labelledby="changes-h" className="grid min-w-0 grid-cols-1 gap-4">
      <div className="flex items-center gap-2">
        <h2 id="changes-h" className="text-[14px] font-semibold">
          Changes
        </h2>
        <Button size="xs" variant="ghost" onClick={() => refetch()} aria-label="Refresh diff" disabled={isFetching}>
          <RefreshCw className={cn("size-3", isFetching && "animate-spin")} aria-hidden />
        </Button>
        <Button size="xs" variant="outline" className="ml-auto" onClick={() => run.mutate(undefined)} disabled={!testable || run.isPending} title={testable ? undefined : "Set a test command on a folder in Settings"}>
          <FlaskConical className="size-3" aria-hidden /> {run.isPending ? "Starting…" : "Run tests"}
        </Button>
      </div>
      {run.isSuccess && <p className="text-muted-foreground text-xs" role="status">Tests started. Results appear here and in Activity.</p>}

      {latestTests.length > 0 && (
        <div className="grid gap-2">
          {latestTests.map((c) => (
            <TestResult key={c.id} p={c.payload as TestPayload} iso={c.createdAt} />
          ))}
        </div>
      )}

      {!diffs && <Skeleton className="h-24" />}
      {diffs?.length === 0 && <p className="text-muted-foreground text-[13px]">No working folders on this issue.</p>}
      {diffs?.map((d) => {
        const add = d.files.reduce((n, f) => n + f.additions, 0);
        const del = d.files.reduce((n, f) => n + f.deletions, 0);
        const risky = d.files.filter((f) => f.risky).length;
        return (
          <div key={d.workspaceId} className="bg-card overflow-hidden rounded-lg border">
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-[13px]">
              <FolderGit2 className="text-muted-foreground size-4" aria-hidden />
              <span className="font-medium">{d.folder}</span>
              {d.branch && (
                <span className="text-muted-foreground font-mono text-xs">
                  {d.base}…{d.branch}
                </span>
              )}
              <span className="ml-auto text-xs tabular-nums">
                {d.files.length} file{d.files.length === 1 ? "" : "s"} · <span className="text-[#4cb782]">+{add}</span> <span className="text-[#eb5757]">−{del}</span>
              </span>
              {risky > 0 && (
                <span className="flex items-center gap-1 text-xs text-[#f2994a]">
                  <ShieldAlert className="size-3.5" aria-hidden /> {risky} protected{ticket.riskApproved ? " · approved" : ""}
                </span>
              )}
            </div>
            {d.merged && (
              <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs">
                {showMerged ? `Showing this branch's changes, already merged into ${d.base}.` : `Branch already merged into ${d.base}. Nothing left to diff.`}
                <Button size="xs" variant="outline" className="ml-auto" onClick={() => setShowMerged(!showMerged)}>
                  {showMerged ? "Hide" : "Show merged changes"}
                </Button>
              </div>
            )}
            {d.error ? (
              <p className="text-muted-foreground px-3 py-3 text-xs">{d.error}</p>
            ) : d.files.length ? (
              d.files.map((f) => <FileRow key={f.path} f={f} ctx={{ ticketId: ticket.id, agents, folder: d.folder, branch: d.branch }} />)
            ) : (
              !d.merged && <p className="text-muted-foreground px-3 py-3 text-xs">No changes yet.</p>
            )}
          </div>
        );
      })}
    </section>
  );
}
