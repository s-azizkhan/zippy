import type { IconType } from "@/lib/anim-icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, ArrowDown, ArrowUp, Archive, ChevronRight, Copy, File, FileCode, FileJson, Folder, FolderSearch, GitBranch, GitCommitHorizontal, Image, RefreshCw, SquareTerminal, UserRound } from "lucide-react";
import { FileTextIcon as FileText } from "@/components/ui/file-text";
import { FolderOpenIcon as FolderOpen } from "@/components/ui/folder-open";
import { SettingsIcon as Settings } from "@/components/ui/settings";
import hljs from "highlight.js/lib/common";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { md } from "@/components/activity";
import { langOf, Patch } from "@/components/changes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { PropertyMenu } from "@/components/property-menu";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api, keys, type TermInfo } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

type Dir = { type: "dir"; entries: { name: string; dir: boolean }[] };
type FileView = { type: "file"; binary: boolean; size: number; truncated?: boolean; content?: string };

const useFs = <T extends Dir | FileView>(id: string, path: string, enabled = true) =>
  useQuery({
    queryKey: ["fs", id, path],
    queryFn: () => api.get<T>(`/workspaces/${id}/fs?path=${encodeURIComponent(path)}`),
    enabled,
  });

const code = [FileCode, "text-sky-500"] as const;
const KIND: Record<string, readonly [IconType, string]> = {
  ts: code, tsx: code, js: code, jsx: code, mjs: code, cjs: code, py: code, php: code, go: code, rs: code, rb: code, java: code, sh: code, sql: code, css: code, html: code,
  json: [FileJson, "text-amber-500"], yaml: [Settings, "text-violet-500"], yml: [Settings, "text-violet-500"], toml: [Settings, "text-violet-500"], env: [Settings, "text-violet-500"],
  md: [FileText, "text-emerald-500"], txt: [FileText, "text-emerald-500"],
  png: [Image, "text-pink-500"], jpg: [Image, "text-pink-500"], jpeg: [Image, "text-pink-500"], gif: [Image, "text-pink-500"], svg: [Image, "text-pink-500"], webp: [Image, "text-pink-500"],
};

type Change = { path: string; status: string; orig?: string };
type Branches = { current: string; local: string[]; remote: string[]; ahead: number; behind: number; upstream: boolean; changes: Change[]; stashes: number; identity: Identity } | null;
type Identity = { name: string; email: string; local: boolean };

const useGit = (id: string) => useQuery({ queryKey: ["git", id], queryFn: () => api.get<Branches>(`/workspaces/${id}/git`), refetchInterval: 15_000 });

// Git status per file, plus every folder holding a change, for tree markers.
const Marks = createContext<{ files: Map<string, string>; dirs: Set<string> }>({ files: new Map(), dirs: new Set() });
const MARK: Record<string, [string, string]> = { M: ["M", "text-amber-500"], A: ["A", "text-emerald-500"], "?": ["U", "text-emerald-500"], D: ["D", "text-red-500"], R: ["R", "text-sky-500"], U: ["!", "text-red-500"] };

function Node({ id, path, name, dir, depth, sel, onSel }: { id: string; path: string; name: string; dir: boolean; depth: number; sel: string; onSel: (p: string) => void }) {
  const onPath = sel.startsWith(`${path}/`);
  const [open, setOpen] = useState(onPath);
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
  const marks = useContext(Marks);
  const mark = dir ? null : MARK[marks.files.get(path) ?? ""];
  const [Icon, color] = dir ? [open ? FolderOpen : Folder, "text-blue-500"] : (KIND[name.split(".").pop()!.toLowerCase()] ?? [File, "opacity-70"]);
  return (
    <>
      <button
        ref={(el) => {
          if (sel === path) el?.scrollIntoView({ block: "nearest" });
        }}
        title={path}
        onClick={() => (dir ? setOpen(!open) : onSel(path))}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn("hover:bg-accent flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs", sel === path && "bg-accent")}
      >
        {dir ? <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden /> : <span className="size-3 shrink-0" />}
        <Icon className={cn("size-3.5 shrink-0", color)} aria-hidden />
        <span className={cn("flex-1 truncate", mark?.[1])}>{name}</span>
        {mark && <span className={cn("shrink-0 font-mono text-[10px] font-semibold", mark[1])} title="Uncommitted change">{mark[0]}</span>}
        {dir && marks.dirs.has(path) && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="Contains changes" aria-label="contains changes" />}
      </button>
      {dir && open && <Tree id={id} path={path} depth={depth + 1} sel={sel} onSel={onSel} />}
    </>
  );
}

function Tree({ id, path, depth, sel, onSel }: { id: string; path: string; depth: number; sel: string; onSel: (p: string) => void }) {
  const { data, error } = useFs<Dir>(id, path);
  if (error) return <p className="text-destructive px-2 text-xs">{error.message}</p>;
  return (
    <>
      {data?.entries.map((e) => (
        <Node key={e.name} id={id} path={path ? `${path}/${e.name}` : e.name} name={e.name} dir={e.dir} depth={depth} sel={sel} onSel={onSel} />
      ))}
    </>
  );
}

function Viewer({ id, path }: { id: string; path: string }) {
  const { data, isLoading, error } = useFs<FileView>(id, path);
  const [raw, setRaw] = useState(false);
  const isMd = /\.(md|markdown)$/i.test(path);
  const html = useMemo(() => {
    const language = langOf(path);
    return data?.content && language ? hljs.highlight(data.content, { language, ignoreIllegals: true }).value : null;
  }, [data, path]);
  if (isLoading) return <p className="text-muted-foreground p-4 text-[13px]">Loading…</p>;
  if (error) return <p className="text-destructive p-4 text-[13px]">{error.message}</p>;
  if (data?.binary) return <p className="text-muted-foreground p-4 text-[13px]">Binary file ({data.size} bytes).</p>;
  return (
    <>
      <div className="bg-background sticky top-0 flex items-start gap-3 border-b px-4 py-2">
        <p className="min-w-0 flex-1 font-mono text-xs break-all">{path}</p>
        <button title="Copy path" aria-label="Copy path" onClick={() => navigator.clipboard.writeText(path).then(() => toast.success("Path copied"))} className="text-muted-foreground hover:text-foreground shrink-0">
          <Copy className="size-3.5" aria-hidden />
        </button>
        <OpenButtons id={id} path={path} />
        {isMd && (
          <button onClick={() => setRaw(!raw)} className="text-muted-foreground hover:text-foreground shrink-0 text-xs font-medium">
            {raw ? "Preview" : "Raw"}
          </button>
        )}
      </div>
      {data?.truncated && <p className="text-muted-foreground border-b px-4 py-1.5 text-xs">Showing first 512 KB of {data.size} bytes.</p>}
      {isMd && !raw ? (
        <div className="p-4 text-[13px]">{md(data?.content ?? "")}</div>
      ) : (
        <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
          {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : data?.content}
        </pre>
      )}
    </>
  );
}

/** Name always whole; directory shrinks first and keeps its tail (rtl clips the left). */
function FileName({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="shrink-0 text-[13px] font-medium">{path.slice(i + 1)}</span>
      {i > 0 && (
        <span className="text-muted-foreground min-w-0 truncate text-xs [direction:rtl]">
          <bdi>{path.slice(0, i)}</bdi>
        </span>
      )}
    </span>
  );
}

/** Cmd/Ctrl+P: jump to any file in the folder. */
function QuickOpen({ id, onPick }: { id: string; onPick: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: files = [] } = useQuery({ queryKey: ["fs-files", id], queryFn: () => api.get<string[]>(`/workspaces/${id}/files`), enabled: open, staleTime: 30_000 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const hits = useMemo(() => {
    const t = q.toLowerCase();
    return (t ? files.filter((f) => f.toLowerCase().includes(t)) : files).slice(0, 50); // cmdk is slow past a few hundred items
  }, [files, q]);
  return (
    <CommandDialog open={open} onOpenChange={(o) => { setOpen(o); setQ(""); }} className="sm:max-w-2xl" title="Go to file" description="Search files in this folder">
      <CommandInput placeholder="Go to file…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>No files.</CommandEmpty>
        {hits.map((f) => (
          <CommandItem key={f} value={f} title={f} onSelect={() => { onPick(f); setOpen(false); setQ(""); }}>
            <FileName path={f} />
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

/** Open in editor / reveal in Finder. Empty path = the folder itself. */
function OpenButtons({ id, path }: { id: string; path: string }) {
  const open = (app: "editor" | "finder") => api.post(`/workspaces/${id}/open`, { path, app }, true).catch((e: Error) => toast.error(e.message));
  return (
    <>
      <button title="Open in editor" aria-label="Open in editor" onClick={() => open("editor")} className="text-muted-foreground hover:text-foreground shrink-0">
        <AppWindow className="size-3.5" aria-hidden />
      </button>
      <button title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => open("finder")} className="text-muted-foreground hover:text-foreground shrink-0">
        <FolderSearch className="size-3.5" aria-hidden />
      </button>
    </>
  );
}

type GitOp = { op: "checkout"; branch: string; stash?: boolean } | { op: "branch"; name: string } | { op: "commit"; message: string; files: string[]; push: boolean } | { op: "identity"; name: string; email: string } | { op: "fetch" | "pull" | "push" | "pop" };

function useGitOp(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ op, ...b }: GitOp) => api.post(`/workspaces/${id}/git/${op}`, b),
    onSettled: (_r, _e, { op }) => {
      const files = op !== "fetch" && op !== "push";
      return Promise.all([qc.invalidateQueries({ queryKey: ["git", id] }), files && qc.invalidateQueries({ queryKey: ["fs", id] }), files && qc.invalidateQueries({ queryKey: ["fs-files", id] })]);
    },
  });
}

/** Pick files, write a message, commit (and optionally push). */
function CommitDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: files = [], isLoading, error } = useQuery({ queryKey: ["git-diff", id], queryFn: () => api.get<(Change & { patch: string })[]>(`/workspaces/${id}/git/diff`), enabled: open, staleTime: 0 });
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const run = useGitOp(id);
  const picked = files.filter((f) => !skip.has(f.path)).map((f) => f.path);
  const commit = (push: boolean) =>
    msg.trim() && picked.length && !run.isPending && run.mutate({ op: "commit", message: msg, files: picked, push }, { onSuccess: () => (setMsg(""), setSkip(new Set()), onOpenChange(false)), onError: (e) => toast.error(e.message) });
  const toggle = (p: string) => setSkip((s) => (s.has(p) ? (s.delete(p), new Set(s)) : new Set(s.add(p))));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-3xl" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), commit(e.shiftKey))}>
        <div className="border-b px-4 py-3">
          <DialogTitle className="text-sm">Commit changes</DialogTitle>
          <DialogDescription className="text-xs">
            {picked.length} of {files.length} files · ⌘↵ commit · ⌘⇧↵ commit & push
          </DialogDescription>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {isLoading && <p className="text-muted-foreground p-4 text-[13px]">Loading…</p>}
          {error && <p className="text-destructive p-4 text-[13px]">{error.message}</p>}
          {!isLoading && !files.length && !error && <p className="text-muted-foreground p-4 text-[13px]">Nothing to commit.</p>}
          {files.map((f) => {
            const m = MARK[f.status];
            return (
              <details key={f.path} className="group border-b last:border-b-0">
                <summary className="hover:bg-accent/50 flex h-8 cursor-pointer list-none items-center gap-2 px-3 text-xs">
                  <input type="checkbox" checked={!skip.has(f.path)} onChange={() => toggle(f.path)} onClick={(e) => e.stopPropagation()} aria-label={`Include ${f.path}`} />
                  <span className={cn("w-3 font-mono font-semibold", m?.[1])}>{m?.[0] ?? f.status}</span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                    {f.orig ? `${f.orig} → ${f.path}` : f.path}
                  </span>
                </summary>
                <div className="bg-background/60 border-t">
                  <Patch patch={f.patch} path={f.path} />
                </div>
              </details>
            );
          })}
        </div>
        <div className="grid gap-2 border-t p-3">
          <Textarea autoFocus value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Commit message" aria-label="Commit message" className="max-h-40 text-[13px]" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={!msg.trim() || !picked.length || run.isPending} onClick={() => commit(true)}>
              Commit & push
            </Button>
            <Button size="sm" disabled={!msg.trim() || !picked.length || run.isPending} onClick={() => commit(false)}>
              {run.isPending ? "Committing…" : "Commit"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Branch switcher (search, create) + fetch/pull/push for the folder's checkout. Hidden for non-git folders. */
function GitBar({ id, data }: { id: string; data: NonNullable<Branches> }) {
  const run = useGitOp(id);
  const switchTo = (branch: string) =>
    run.mutate(
      { op: "checkout", branch },
      {
        onError: (e) =>
          /stash them|would be overwritten/.test(e.message)
            ? toast.error("Local changes block the switch", { description: e.message, duration: 15_000, action: { label: "Stash & switch", onClick: () => run.mutate({ op: "checkout", branch, stash: true }, { onError: (e) => toast.error(e.message) }) } })
            : toast.error(e.message),
      },
    );
  const busy = run.isPending ? run.variables.op : null;
  return (
    <div className="flex items-center gap-0.5 border-b p-1.5">
      <PropertyMenu
        numbered={false}
        value={data.current}
        onChange={(branch) => branch !== data.current && switchTo(branch)}
        onCreate={(name) => run.mutate({ op: "branch", name }, { onError: (e) => toast.error(e.message) })}
        options={[...data.local.map((b) => ({ value: b, label: b, group: "Local" })), ...data.remote.map((b) => ({ value: b, label: b, group: "Remote" }))]}
        triggerLabel="Switch branch"
        placeholder="Switch or create branch…"
        className="h-7 flex-1 gap-1.5 px-1.5 text-xs"
        trigger={
          <>
            <GitBranch className={cn("size-3.5 shrink-0", (busy === "checkout" || busy === "branch") && "animate-pulse")} aria-hidden />
            <span className="truncate font-medium">{data.current || "(detached)"}</span>
          </>
        }
      />
      <button title="Fetch all remotes" aria-label="Git fetch" disabled={!!busy} onClick={() => run.mutate({ op: "fetch" }, { onError: (e) => toast.error(e.message) })} className={BTN}>
        <RefreshCw className={cn("size-3.5", busy === "fetch" && "animate-spin")} aria-hidden />
      </button>
      <button title={data.upstream ? "Pull (fast-forward only)" : "No upstream to pull from"} aria-label="Git pull" disabled={!!busy || !data.upstream} onClick={() => run.mutate({ op: "pull" }, { onError: (e) => toast.error(e.message) })} className={BTN}>
        <ArrowDown className={cn("size-3.5", busy === "pull" && "animate-pulse")} aria-hidden />
        {data.behind > 0 && data.behind}
      </button>
      <button title={data.upstream ? "Push" : "Push and set upstream"} aria-label="Git push" disabled={!!busy || !data.current} onClick={() => run.mutate({ op: "push" }, { onError: (e) => toast.error(e.message) })} className={BTN}>
        <ArrowUp className={cn("size-3.5", busy === "push" && "animate-pulse")} aria-hidden />
        {data.ahead > 0 && data.ahead}
      </button>
    </div>
  );
}

const BTN = "text-muted-foreground hover:text-foreground hover:bg-accent flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums disabled:opacity-50";

/** Commit author for this folder: shows the effective git identity; saving writes the repo's own config. */
function IdentityMenu({ id, identity }: { id: string; identity: Identity }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const run = useGitOp(id);
  const save = (n: string, e: string) => run.mutate({ op: "identity", name: n, email: e }, { onSuccess: () => setOpen(false), onError: (e) => toast.error(e.message) });
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && (setName(identity.name), setEmail(identity.email)))}>
      <PopoverTrigger title={`Commit as ${identity.name || "?"} <${identity.email || "?"}>${identity.local ? " (this folder)" : " (global)"}`} aria-label="Git author" className={cn(BTN, identity.local && "text-sky-500")}>
        <UserRound className="size-3.5" aria-hidden />
        {!identity.email && <span className="text-red-500">!</span>}
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-72 gap-2 p-3">
        <form className="grid gap-2" onSubmit={(e) => (e.preventDefault(), save(name.trim(), email.trim()))}>
          <p className="text-xs font-medium">Commit author for this folder</p>
          <p className="text-muted-foreground text-xs">{identity.local ? "Set for this folder only." : "Using your global git config. Saving sets it for this folder only."}</p>
          <Input aria-label="user.name" placeholder="user.name" value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-xs" />
          <Input aria-label="user.email" type="email" placeholder="user.email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-7 text-xs" />
          <div className="flex justify-end gap-2">
            {identity.local && (
              <Button type="button" size="sm" variant="ghost" disabled={run.isPending} onClick={() => save("", "")} title="Remove this folder's override">
                Use global
              </Button>
            )}
            <Button type="submit" size="sm" disabled={run.isPending || (name.trim() === identity.name && email.trim() === identity.email && identity.local)}>
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Folder actions: uncommitted changes → commit, stash pop, terminal, editor, Finder. */
function FolderBar({ id, git }: { id: string; git: Branches | undefined }) {
  const org = useOrg();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const run = useGitOp(id);
  const [committing, setCommitting] = useState(false);
  const termKey = keys.res(org.id, "terminals");
  const terminal = () =>
    api
      .post<TermInfo>(`/workspaces/${id}/terminals`, {}, true)
      .then((t) => (qc.setQueryData<TermInfo[]>(termKey, (ts = []) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t])), navigate(`/terminals/${t.id}`)))
      .catch((e: Error) => toast.error(e.message));
  const n = git?.changes.length ?? 0;
  return (
    <div className="flex items-center gap-0.5 border-b px-1.5 py-1">
      {git && (
        <button title={n ? "Review & commit changes" : "No uncommitted changes"} disabled={!n} onClick={() => setCommitting(true)} className={cn(BTN, n > 0 && "text-amber-500 hover:text-amber-400")}>
          <GitCommitHorizontal className="size-3.5" aria-hidden />
          {n > 0 ? `${n} changed` : "Clean"}
        </button>
      )}
      {!!git?.stashes && (
        <button title={`Pop latest stash (${git.stashes} stashed)`} disabled={run.isPending} onClick={() => run.mutate({ op: "pop" }, { onError: (e) => toast.error(e.message) })} className={BTN}>
          <Archive className="size-3.5" aria-hidden />
          {git.stashes}
        </button>
      )}
      {git && <IdentityMenu id={id} identity={git.identity} />}
      <span className="flex-1" />
      <button title="Open terminal here" aria-label="Open terminal here" onClick={terminal} className={BTN}>
        <SquareTerminal className="size-3.5" aria-hidden />
      </button>
      <span className="flex items-center gap-2 px-1.5">
        <OpenButtons id={id} path="" />
      </span>
      {git && <CommitDialog id={id} open={committing} onOpenChange={setCommitting} />}
    </div>
  );
}

/** Read-only file tree + viewer for a working folder. */
export function FileBrowser({ id }: { id: string }) {
  const [sel, setSel] = useState("");
  const { data: git } = useGit(id);
  const marks = useMemo(() => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    for (const c of git?.changes ?? []) {
      files.set(c.path, c.status);
      for (let i = c.path.indexOf("/"); i > 0; i = c.path.indexOf("/", i + 1)) dirs.add(c.path.slice(0, i));
    }
    return { files, dirs };
  }, [git]);
  return (
    <Marks.Provider value={marks}>
    <div className="flex min-h-0 flex-1">
      <QuickOpen id={id} onPick={setSel} />
      <div className={cn("flex w-full shrink-0 flex-col border-r md:w-64", sel && "max-md:hidden")}>
        {git && <GitBar id={id} data={git} />}
        <FolderBar id={id} git={git} />
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <Tree id={id} path="" depth={0} sel={sel} onSel={setSel} />
        </div>
      </div>
      <div className={cn("min-w-0 flex-1 overflow-auto", !sel && "max-md:hidden")}>
        {sel && (
          <button onClick={() => setSel("")} className="text-muted-foreground hover:text-foreground flex items-center gap-1 border-b px-4 py-2 text-xs font-medium md:hidden">
            <ChevronRight className="size-3 rotate-180" aria-hidden /> Files
          </button>
        )}
        {sel ? <Viewer id={id} path={sel} /> : <p className="text-muted-foreground p-4 text-[13px]">Select a file to view.</p>}
      </div>
    </div>
    </Marks.Provider>
  );
}
