import { FlaskConical, FolderGit2, RefreshCw, ShieldAlert } from "lucide-react";
import type { Comment, DiffFile, TestPayload, Ticket } from "@zippy/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useApiMutation, useDiff, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn } from "@/lib/utils";

const HEADER = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/;

function Patch({ patch }: { patch: string }) {
  if (!patch) return <p className="text-muted-foreground px-3 py-2 text-xs">New untracked file, or binary. No text diff.</p>;
  const lines = patch.split("\n").filter((l) => !HEADER.test(l));
  return (
    <pre className="overflow-x-auto py-1 font-mono text-[12px] leading-5" aria-label="Diff">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre",
            l.startsWith("+") && "bg-[#4cb782]/12 text-[#7fd1a8]",
            l.startsWith("-") && "bg-[#eb5757]/12 text-[#f19a9a]",
            l.startsWith("@@") && "text-muted-foreground bg-[#5e6ad2]/10",
          )}
        >
          <span className="sr-only">{l.startsWith("+") ? "added: " : l.startsWith("-") ? "removed: " : ""}</span>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function FileRow({ f }: { f: DiffFile }) {
  return (
    <details className="group border-b last:border-b-0">
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
      </summary>
      <div className="bg-background/60 border-t">
        <Patch patch={f.patch} />
      </div>
    </details>
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
export function Changes({ ticket, comments }: { ticket: Ticket; comments: Comment[] }) {
  const org = useOrg();
  const { data: diffs, isFetching, refetch } = useDiff(ticket.id, true);
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
            {d.error ? (
              <p className="text-muted-foreground px-3 py-3 text-xs">{d.error}</p>
            ) : d.files.length ? (
              d.files.map((f) => <FileRow key={f.path} f={f} />)
            ) : (
              <p className="text-muted-foreground px-3 py-3 text-xs">No changes yet.</p>
            )}
          </div>
        );
      })}
    </section>
  );
}
