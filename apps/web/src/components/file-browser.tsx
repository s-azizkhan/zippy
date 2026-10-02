import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, FileCode, FileJson, FileText, Folder, FolderOpen, Image, Settings, type LucideIcon } from "lucide-react";
import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useState } from "react";
import { md } from "@/components/activity";
import { langOf } from "@/components/changes";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api } from "@/lib/api";
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
const KIND: Record<string, readonly [LucideIcon, string]> = {
  ts: code, tsx: code, js: code, jsx: code, mjs: code, cjs: code, py: code, php: code, go: code, rs: code, rb: code, java: code, sh: code, sql: code, css: code, html: code,
  json: [FileJson, "text-amber-500"], yaml: [Settings, "text-violet-500"], yml: [Settings, "text-violet-500"], toml: [Settings, "text-violet-500"], env: [Settings, "text-violet-500"],
  md: [FileText, "text-emerald-500"], txt: [FileText, "text-emerald-500"],
  png: [Image, "text-pink-500"], jpg: [Image, "text-pink-500"], jpeg: [Image, "text-pink-500"], gif: [Image, "text-pink-500"], svg: [Image, "text-pink-500"], webp: [Image, "text-pink-500"],
};

function Node({ id, path, name, dir, depth, sel, onSel }: { id: string; path: string; name: string; dir: boolean; depth: number; sel: string; onSel: (p: string) => void }) {
  const onPath = sel.startsWith(`${path}/`);
  const [open, setOpen] = useState(onPath);
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
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
        <span className="truncate">{name}</span>
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

/** Read-only file tree + viewer for a working folder. */
export function FileBrowser({ id }: { id: string }) {
  const [sel, setSel] = useState("");
  return (
    <div className="flex min-h-0 flex-1">
      <QuickOpen id={id} onPick={setSel} />
      <div className="w-64 shrink-0 overflow-y-auto border-r p-1.5">
        <Tree id={id} path="" depth={0} sel={sel} onSel={setSel} />
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {sel ? <Viewer id={id} path={sel} /> : <p className="text-muted-foreground p-4 text-[13px]">Select a file to view.</p>}
      </div>
    </div>
  );
}
