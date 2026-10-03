import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine } from "lucide-react";
import { ExternalLinkIcon as ExternalLink } from "@/components/ui/external-link";
import { RefreshCWIcon as RefreshCw } from "@/components/ui/refresh-cw";
import { XIcon as X } from "@/components/ui/x";
import { createContext, useContext, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { useNavigate } from "react-router";
import type { Ticket } from "@zippy/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, keys, queryClient, useTickets, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";

type LinearIssue = {
  uuid: string;
  id: string;
  title: string;
  description?: string | null;
  url: string;
  status: string;
  priority?: { name: string };
  assignee?: string | null;
  statusType?: string;
  createdBy?: string;
  team?: string;
  dueDate?: string | null;
  createdAt?: string;
  labels?: string[];
  links?: { id: string; title: string; url: string }[];
  comments?: { id: string; body: string; createdAt: string; author: string | null; parentId: string | null }[];
};

const OpenIssue = createContext<(id: string) => void>(() => {});
const LINEAR_ISSUE_URL = /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/;

/** Markdown where Linear issue links open in the preview panel instead of leaving the app. */
function Md({ children }: { children: string }) {
  const open = useContext(OpenIssue);
  return (
    <Markdown
      components={{
        a: ({ href, children }) => {
          const id = href && LINEAR_ISSUE_URL.exec(href)?.[1]?.toUpperCase();
          return id ? (
            <button type="button" onClick={() => open(id)} className="text-primary font-medium underline underline-offset-2">
              {children}
            </button>
          ) : (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          );
        },
      }}
    >
      {children}
    </Markdown>
  );
}

const STEPS = ["Fetching issue from Linear…", "Reading comments…", "Pulling in images…"];

const ago = (d: string) => {
  const m = (new Date(d).getTime() - Date.now()) / 60_000;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of [["day", 1440], ["hour", 60]] as const) if (Math.abs(m) >= size) return rtf.format(Math.round(m / size), unit);
  return rtf.format(Math.round(m), "minute");
};

const DOT: Record<string, string> = { backlog: "bg-zinc-400", unstarted: "bg-zinc-500", started: "bg-amber-500", completed: "bg-emerald-500", canceled: "bg-red-400" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </>
  );
}

function IssueMeta({ issue: i }: { issue: LinearIssue }) {
  return (
    <dl className="bg-muted/40 grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-2 rounded-lg border p-3 text-xs">
      {i.status && (
        <Field label="Status">
          <span className={cn("size-2 rounded-full", DOT[i.statusType ?? ""] ?? "bg-zinc-400")} />
          {i.status}
        </Field>
      )}
      {i.priority && <Field label="Priority">{i.priority.name}</Field>}
      <Field label="Assignee">{i.assignee ?? <span className="text-muted-foreground">Unassigned</span>}</Field>
      {i.team && <Field label="Team">{i.team}</Field>}
      {!!i.labels?.length && (
        <Field label="Labels">
          {i.labels.map((l) => (
            <span key={l} className="bg-background rounded-full border px-2 py-0.5">{l}</span>
          ))}
        </Field>
      )}
      {i.dueDate && <Field label="Due">{new Date(i.dueDate).toLocaleDateString()}</Field>}
      {i.createdBy && <Field label="Created by">{i.createdBy}</Field>}
      {!!i.links?.length && (
        <Field label="Links">
          {i.links.map((l) => (
            <a key={l.id} href={l.url} target="_blank" rel="noreferrer" title={l.title} className="hover:bg-accent bg-background max-w-full truncate rounded-full border px-2 py-0.5 underline-offset-2 hover:underline">
              {l.title}
            </a>
          ))}
        </Field>
      )}
    </dl>
  );
}

type LComment = NonNullable<LinearIssue["comments"]>[number];

function CommentCard({ c, i }: { c: LComment; i: number }) {
  const name = c.author ?? "Unknown";
  return (
    <div className="rise flex gap-2.5" style={{ "--i": i } as React.CSSProperties}>
      <span className="bg-primary/15 text-primary mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold uppercase" aria-hidden>
        {name[0]}
      </span>
      <div className="bg-muted/40 min-w-0 flex-1 rounded-lg border px-3 py-2">
        <div className="mb-1 flex items-baseline gap-2 text-xs">
          <span className="font-medium">{name}</span>
          <time className="text-muted-foreground" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>
            {ago(c.createdAt)}
          </time>
        </div>
        <div className="md text-[13px]">
          <Md>{c.body}</Md>
        </div>
      </div>
    </div>
  );
}

function Comments({ list }: { list: LComment[] }) {
  if (!list.length) return null;
  const roots = list.filter((c) => !c.parentId || !list.some((p) => p.id === c.parentId));
  return (
    <section aria-label="Comments" className="mt-6 border-t pt-4">
      <h3 className="mb-3 text-xs font-medium">
        Comments <span className="text-muted-foreground font-normal">{list.length}</span>
      </h3>
      <div className="grid gap-3">
        {roots.map((c, i) => (
          <div key={c.id} className="grid gap-2">
            <CommentCard c={c} i={i} />
            <div className="border-border/70 ml-3 grid gap-2 border-l pl-5 empty:hidden">
              {list.filter((r) => r.parentId === c.id).map((r, k) => (
                <CommentCard key={r.id} c={r} i={k} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PreviewLoader({ title }: { title?: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((i) => (i + 1) % STEPS.length), 1400);
    return () => clearInterval(t);
  }, []);
  return (
    <div role="status" aria-live="polite" className="grid gap-3">
      {title && <h2 className="text-base font-medium">{title}</h2>}
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <span className="flex gap-0.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="bg-primary size-1.5 rounded-full" style={{ animation: "agent-dot 1s ease-in-out infinite", animationDelay: `${i * 150}ms` }} />
          ))}
        </span>
        <span key={n} className="rise">{STEPS[n]}</span>
      </p>
      {[100, 92, 96, 60].map((w, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />
      ))}
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function useLinearIssue(orgId: string, id: string | null) {
  return useQuery({
    queryKey: keys.res(orgId, `linear-issue-${id}`),
    queryFn: () => api.get<LinearIssue>(`/orgs/${orgId}/linear/issues/${id}`),
    retry: false,
    enabled: !!id,
    staleTime: 30 * 60_000,
  });
}

/** Imports a Linear issue as a Zippy ticket and opens it. */
function useBring() {
  const org = useOrg();
  const navigate = useNavigate();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function bring(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const t = await api.post<Ticket>(`/orgs/${org.id}/linear/import`, {
        ref: id,
        workspaceIds: workspaces[0] ? [workspaces[0].id] : [],
      });
      queryClient.invalidateQueries({ queryKey: keys.res(org.id, "tickets") });
      navigate(`/t/${t.identifier}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { bring, busy, error };
}

function IssuePreview({ id, title }: { id: string; title?: string }) {
  const org = useOrg();
  const { data: full, isFetching, error } = useLinearIssue(org.id, id);
  if (error) return <p className="text-destructive text-[13px]">{error.message}</p>;
  if (isFetching && !full) return <PreviewLoader title={title} />;
  if (!full) return null;
  return (
    <div className="rise">
      <h2 className="mb-3 text-base font-medium">{full.title}</h2>
      <IssueMeta issue={full} />
      <div className="md mt-4 text-[13px]">
        <Md>{full.description || "_No description._"}</Md>
      </div>
      <Comments list={full.comments ?? []} />
    </div>
  );
}

/** Any Linear issue link clicked in the app (descriptions, comments) opens here instead of a new tab. */
export function LinearIssueModal() {
  const org = useOrg();
  const navigate = useNavigate();
  const { data: tickets = [] } = useTickets(org?.id);
  const [id, setId] = useState<string | null>(null);
  const { bring, busy, error } = useBring();
  const { data: full } = useLinearIssue(org?.id, id);
  useEffect(() => {
    if (!org?.linearConnected) return;
    const onClick = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      const a = (e.target as Element).closest?.("a");
      const m = a && !a.hasAttribute("data-external") && LINEAR_ISSUE_URL.exec(a.href);
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      setId(m[1]!.toUpperCase());
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [org?.linearConnected]);
  const imported = !!id && tickets.some((t) => t.identifier === id);
  return (
    <OpenIssue.Provider value={setId}>
      <Dialog open={!!id} onOpenChange={(o) => !o && setId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogTitle className="text-muted-foreground flex items-center gap-2 font-mono text-xs font-normal">
            {id}
            {full?.url && (
              <a href={full.url} target="_blank" rel="noreferrer" aria-label="Open in Linear"
                data-external className="hover:text-foreground">
                <ExternalLink className="size-3" />
              </a>
            )}
          </DialogTitle>
          {id && <IssuePreview id={id} />}
          {error && <p className="text-destructive text-[13px]">{error}</p>}
          {id && (
            <DialogFooter>
              <Button
                disabled={busy}
                onClick={() => {
                  if (!imported) return bring(id);
                  setId(null);
                  navigate(`/t/${id}`);
                }}
              >
                <ArrowDownToLine className="size-4" aria-hidden />
                {imported ? "Open in Zippy" : busy ? "Bringing…" : "Bring to Zippy"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </OpenIssue.Provider>
  );
}

/** Linear issues assigned to / mentioning the user. Select one to preview, float button imports it. */
export function LinearIssues() {
  const org = useOrg();
  const navigate = useNavigate();
  const { linearUser, setLinearUser } = useUI();
  const [draft, setDraft] = useState("");
  const [ref, setRef] = useState("");
  const [openErr, setOpenErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const { bring, busy, error: bringErr } = useBring();
  const { data: tickets = [] } = useTickets(org.id);
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const listKey = keys.res(org.id, `linear-issues-${linearUser}`);
  const listPath = `/orgs/${org.id}/linear/issues?user=${encodeURIComponent(linearUser)}`;
  const {
    data: all = { at: 0, issues: [] },
    isLoading,
    error,
  } = useQuery({
    queryKey: listKey,
    queryFn: () => api.get<{ at: number; issues: LinearIssue[] }>(listPath),
    enabled: !!linearUser,
    staleTime: 30 * 60_000,
  });
  const statuses = [...new Set(all.issues.map((i) => i.status))];
  const issues = status
    ? all.issues.filter((i) => i.status === status)
    : all.issues;

  async function refresh() {
    setRefreshing(true);
    try {
      queryClient.setQueryData(listKey, await api.get(`${listPath}&fresh=1`));
    } finally {
      setRefreshing(false);
    }
  }

  if (!linearUser)
    return (
      <form
        className="grid place-items-center gap-3 p-20 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setLinearUser(draft.trim());
        }}
      >
        <p className="text-muted-foreground">
          Enter your Linear username to list issues assigned to or mentioning
          you.
        </p>
        <div className="flex gap-2">
          <input
            aria-label="Linear username"
            placeholder="username"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="bg-background h-8 rounded-md border px-2 outline-none"
            autoFocus
          />
          <Button size="sm" type="submit" disabled={!draft.trim()}>
            Save
          </Button>
        </div>
      </form>
    );

  const { data: full, error: fullError } = useLinearIssue(org.id, sel);
  const current = all.issues.find((i) => i.id === sel);
  const imported = (id: string) => tickets.some((t) => t.identifier === id);

  async function open(e: React.FormEvent) {
    e.preventDefault();
    const id = /[A-Za-z][A-Za-z0-9]+-\d+/.exec(ref)?.[0].toUpperCase();
    if (!id) return setOpenErr("Use an ID like COM-603.");
    setOpenErr("");
    setSel(id);
  }

  return (
    <OpenIssue.Provider value={setSel}>
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="text-muted-foreground flex h-9 items-center gap-2 border-b px-4 text-xs">
          Assigned to or mentioning{" "}
          <span className="text-foreground font-medium">{linearUser}</span>
          <button
            className="underline underline-offset-4"
            onClick={() => setLinearUser("")}
          >
            change
          </button>
          <form onSubmit={open} className="ml-auto flex items-center gap-1">
            <input
              aria-label="Open Linear issue by ID"
              placeholder="Open ID, e.g. COM-603"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              className="bg-background h-6 w-44 rounded-md border px-2 outline-none"
            />
            <Button size="xs" type="submit" disabled={!ref.trim() || busy}>
              Open
            </Button>
          </form>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="bg-background h-6 rounded-md border px-1"
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button
            aria-label="Refresh from Linear"
            title={
              all.at
                ? `Cached ${new Date(all.at).toLocaleTimeString()}. Click to refetch.`
                : "Refetch"
            }
            onClick={refresh}
            disabled={refreshing}
            className="hover:text-foreground rounded p-1"
          >
            <RefreshCw
              className={cn("size-3.5", refreshing && "animate-spin")}
              aria-hidden
            />
          </button>
        </div>
        {(openErr || bringErr) && (
          <p className="text-destructive px-4 pt-2 text-[13px]">{openErr || bringErr}</p>
        )}
        {isLoading && (
          <div className="grid gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        )}
        {error && (
          <p className="text-destructive p-4 text-[13px]">{error.message}</p>
        )}
        {!isLoading && !error && !issues.length && (
          <p className="text-muted-foreground p-20 text-center text-[13px]">
            No Linear issues found.
          </p>
        )}
        <ul>
          {issues.map((i) => (
            <li key={i.id}>
              <button
                onClick={() => setSel(i.id)}
                className={cn(
                  "hover:bg-accent/50 border-border/60 flex h-11 w-full items-center gap-3 border-b px-4 text-left text-[13px]",
                  sel === i.id && "bg-accent",
                )}
              >
                <span className="text-muted-foreground w-20 shrink-0 font-mono text-xs">
                  {i.id}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {i.title}
                </span>
                {imported(i.id) && (
                  <span className="text-muted-foreground text-xs">
                    In Zippy
                  </span>
                )}
                <span className="text-muted-foreground text-xs">
                  {i.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {sel && (
        <aside className="hidden w-[440px] shrink-0 overflow-y-auto border-l p-4 pb-24 lg:block">
          <div className="text-muted-foreground mb-1 flex items-center gap-2 font-mono text-xs">
            {sel}
            {(full?.url ?? current?.url) && (
              <a
                href={full?.url ?? current?.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Linear"
                data-external
                className="hover:text-foreground"
              >
                <ExternalLink className="size-3" />
              </a>
            )}
            <button
              aria-label="Close preview"
              onClick={() => setSel(null)}
              className="hover:text-foreground ml-auto rounded p-1"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <IssuePreview id={sel} title={current?.title} />
        </aside>
      )}
      {sel && (
        <Button
          className="fixed right-6 bottom-6 z-20 rounded-full shadow-lg"
          disabled={busy || !!fullError}
          onClick={() => (imported(sel) ? navigate(`/t/${sel}`) : bring(sel))}
        >
          <ArrowDownToLine className="size-4" aria-hidden />
          {imported(sel) ? "Open in Zippy" : busy ? "Bringing…" : "Bring to Zippy"}
        </Button>
      )}
    </div>
    </OpenIssue.Provider>
  );
}
