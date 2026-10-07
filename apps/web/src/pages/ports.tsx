import { useQuery } from "@tanstack/react-query";
import { Radio, RefreshCw, Search, Skull, Square, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, useApiMutation, useTerminals, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn } from "@/lib/utils";

export type PortInfo = { port: number; addr: string; pid: number; ppid: number; name: string; command: string; cwd: string | null; started: string; user: string; cpu: number; mem: number; terminalId: string | null; self: boolean };

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

export function PortsPage() {
  const org = useOrg();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { data: terms = [] } = useTerminals(org.id);
  const { data: ports = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ["system", "ports"], queryFn: () => api.get<PortInfo[]>("/system/ports"), refetchInterval: 5000 });
  const [q, setQ] = useState("");
  const [victim, setVictim] = useState<(PortInfo & { pids: number[] }) | null>(null);
  const kill = useApiMutation((v: { port: number; pids: number[]; force: boolean }) => api.post<{ killed: number[] }>(`/system/ports/${v.port}/kill`, { pids: v.pids, force: v.force }, true), [["system", "ports"]]);

  const needle = q.trim().toLowerCase();
  const asPort = /^\d+$/.test(needle) ? Number(needle) : null;
  // One row per port + process name: nginx-style worker pools collapse into "× N".
  const grouped = [...ports.reduce((m, p) => {
    const k = `${p.port}:${p.addr}:${p.name}`;
    const g = m.get(k);
    if (g) {
      g.pids.push(p.pid);
      g.cpu += p.cpu;
      g.mem += p.mem;
    } else m.set(k, { ...p, pids: [p.pid] });
    return m;
  }, new Map<string, PortInfo & { pids: number[] }>()).values()];
  const rows = grouped.filter((p) => !needle || (asPort !== null ? String(p.port).startsWith(needle) : [p.name, p.command, p.cwd ?? "", ...p.pids.map(String)].some((s) => s.toLowerCase().includes(needle))));
  const folderOf = (cwd: string | null) => (cwd ? workspaces.find((w) => cwd === w.path || cwd.startsWith(w.path + "/")) : undefined);

  const stop = (force: boolean) => {
    const v = victim!;
    kill.mutateAsync({ port: v.port, pids: v.pids, force }).then(
      (r) => (toast.success(`${force ? "Killed" : "Stopped"} ${v.name} (pid ${r.killed.join(", ")})`), setVictim(null)),
      () => setVictim(null),
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-[1040px] px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.01em]">Ports</h1>
          <p className="text-muted-foreground mt-1 text-[13px]">Everything listening on this machine, which command opened it, and a stop button.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn(isFetching && "animate-spin")} aria-hidden /> Refresh
        </Button>
      </div>

      <label className="border-foreground/[0.07] bg-background focus-within:border-primary/40 sticky top-0 z-10 mt-6 flex h-9 items-center gap-2 rounded-xl border px-3 shadow-[0_8px_16px_-12px_rgb(0_0_0/0.5)]">
        <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Inspect a port (e.g. 3000) or filter by process, folder, command…" aria-label="Inspect port" className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
        {q && (
          <button aria-label="Clear" onClick={() => setQ("")} className="text-muted-foreground hover:text-foreground">
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </label>

      {asPort !== null && !rows.length && !isLoading && (
        <p className="text-muted-foreground mt-4 rounded-xl border border-dashed px-4 py-6 text-center text-[13px]">
          Nothing is listening on port <span className="text-foreground font-mono">{asPort}</span>. It's free.
        </p>
      )}

      <ul className="mt-4 grid gap-2" aria-live="polite">
        {rows.map((p) => {
          const folder = folderOf(p.cwd);
          const term = p.terminalId ? terms.find((t) => t.id === p.terminalId) : undefined;
          return (
            <li key={`${p.pid}:${p.port}:${p.addr}`} className="bg-card grid grid-cols-[5.5rem_1fr_auto_auto] items-center gap-3 rounded-xl border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Radio className={cn("size-3.5 shrink-0", p.self ? "text-primary" : "text-emerald-500")} aria-hidden />
                <span className="font-mono text-[15px] font-semibold tabular-nums">{p.port}</span>
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground font-mono text-[11px]">{p.pids.length > 1 ? `${p.pids.length} processes` : `pid ${p.pid}`}</span>
                  <span className="text-muted-foreground font-mono text-[11px]">{p.addr === "*" ? "all interfaces" : p.addr}</span>
                  {p.started && <span className="text-muted-foreground text-[11px]">started {ago(p.started)}</span>}
                  {p.self && <span className="bg-primary/10 text-primary rounded px-1.5 py-px text-[10px] font-medium">Zippy</span>}
                  {folder && <span className="bg-foreground/[0.06] rounded px-1.5 py-px text-[10px] font-medium">{folder.name}</span>}
                  {term && (
                    <Link to={`/terminals/${term.id}`} className="text-primary flex items-center gap-1 text-[11px] hover:underline">
                      <TerminalSquare className="size-3" aria-hidden /> from terminal “{term.title}”
                    </Link>
                  )}
                </div>
                <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]" title={p.command}>
                  {p.cwd && <span className="text-foreground/70">{home(p.cwd)} </span>}
                  <span>$ {home(p.command)}</span>
                </p>
              </div>
              <div className="text-muted-foreground hidden w-24 shrink-0 text-right font-mono text-[11px] tabular-nums sm:block" aria-label="CPU and memory">
                <div className={cn(p.cpu >= 50 && "text-amber-500")}>{p.cpu.toFixed(1)}% cpu</div>
                <div>{mb(p.mem)}</div>
              </div>
              <Button size="xs" variant="outline" disabled={p.self} title={p.self ? "This is Zippy's own server" : undefined} onClick={() => setVictim(p)}>
                <Square className="size-2.5 fill-current" aria-hidden /> Stop
              </Button>
            </li>
          );
        })}
      </ul>
      {!isLoading && !ports.length && <p className="text-muted-foreground mt-6 rounded-xl border border-dashed px-4 py-8 text-center text-[13px]">No listening ports found.</p>}

      <Dialog open={!!victim} onOpenChange={(o) => !o && setVictim(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop {victim?.name} on port {victim?.port}?</DialogTitle>
            <DialogDescription className="font-mono text-xs break-all">
              {victim && (victim.pids.length > 1 ? `pids ${victim.pids.join(", ")}` : `pid ${victim.pid}`)} · {victim && home(victim.command)}
            </DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-[13px]">Stop sends SIGTERM so the process can shut down cleanly. Kill sends SIGKILL if it ignores that.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVictim(null)}>
              Cancel
            </Button>
            <Button variant="outline" disabled={kill.isPending} onClick={() => stop(true)}>
              <Skull aria-hidden /> Kill
            </Button>
            <Button variant="destructive" disabled={kill.isPending} onClick={() => stop(false)}>
              <Square className="size-2.5 fill-current" aria-hidden /> Stop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </div>
  );
}
