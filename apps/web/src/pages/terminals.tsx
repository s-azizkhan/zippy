import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { BookmarkPlus, ChevronDown, ChevronUp, Columns2, Eraser, FolderOpen, GripVertical, Keyboard, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RotateCw, Search, SquareX, Trash2, X } from "lucide-react";
import { motion, Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TerminalTemplate, TerminalTemplateInput, Workspace } from "@zippy/shared";
import { Field } from "@/components/field";
import { FileBrowser } from "@/components/file-browser";
import { OptionSelect } from "@/components/property-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, keys, useApiMutation, useTerminalTemplates, useWorkspaces, type TermInfo } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";
import type { PortInfo } from "@/pages/ports";

const MAX_PANES = 6;
const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "fish", "sh", "login"]);
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };
/** Quote a path for the shell line unless it's plain. */
const shellQuote = (p: string) => (/^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

const THEME = {
  background: "#0f0f10",
  foreground: "#c9cacd",
  cursor: "#8b93e6",
  cursorAccent: "#0f0f10",
  selectionBackground: "#5e6ad255",
  black: "#1b1b1f", red: "#f2777a", green: "#7fd88f", yellow: "#f5c26b", blue: "#7aa2f7", magenta: "#c49bf2", cyan: "#6fd3d6", white: "#c9cacd",
  brightBlack: "#5c5f66", brightRed: "#ff8f91", brightGreen: "#9be8a8", brightYellow: "#ffd58a", brightBlue: "#9bb8ff", brightMagenta: "#d6b4ff", brightCyan: "#8fe6e8", brightWhite: "#eeeff1",
};

/** Interactive shell attached to a server-side PTY. Output streams over SSE, keystrokes go back over POST. */
function PtyTerminal({ id, focused, fontSize, findReq, onFocus, onRestart }: { id: string; focused: boolean; fontSize: number; findReq: number; onFocus: () => void; onRestart: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ t: XTerm; fit: FitAddon; search: SearchAddon } | null>(null);
  const cb = useRef({ onFocus, onRestart });
  cb.current = { onFocus, onRestart };
  const [find, setFind] = useState<string | null>(null);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = host.current!;
    const t = new XTerm({ cursorBlink: true, fontSize, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", scrollback: 10_000, allowProposedApi: true, theme: THEME });
    const fit = new FitAddon();
    const search = new SearchAddon();
    t.loadAddon(fit);
    t.loadAddon(search);
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")));
    t.open(el);
    term.current = { t, fit, search };
    t.textarea?.addEventListener("focus", () => cb.current.onFocus());
    // ⌘F belongs to the focused pane's find bar, not the browser.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && e.key === "f") return (e.preventDefault(), setFind((f) => f ?? ""), false);
      return true;
    });

    // ponytail: one POST per xterm data event; keystrokes on localhost are cheap enough.
    // Replaying scrollback re-triggers old terminal queries (colour, DA, cursor position); their replies must not reach the shell as typed text.
    let replaying = false;
    let alive = true;
    t.onData((data) => {
      if (replaying) return;
      if (!alive) return void (data === "\r" && cb.current.onRestart()); // Enter on a dead shell restarts it
      void api.post(`/terminals/${id}/input`, { data }, true).catch(() => {});
    });

    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      if (!el.offsetWidth) return; // hidden (another pane is zoomed)
      fit.fit();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void api.post(`/terminals/${id}/resize`, { cols: t.cols, rows: t.rows }, true).catch(() => {}), 80);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const es = new EventSource(`/api/terminals/${id}/events`);
    es.addEventListener("replay", (e) => {
      replaying = true;
      t.write(JSON.parse((e as MessageEvent).data), () => (replaying = false));
    });
    es.onmessage = (e) => t.write(JSON.parse(e.data));
    es.addEventListener("exit", (e) => {
      alive = false;
      const code = Number((e as MessageEvent).data);
      t.write(`\r\n\x1b[${code ? "31" : "2"}m[process exited with code ${code}]\x1b[0m \x1b[2m— press Enter to restart\x1b[0m\r\n`);
    });
    es.addEventListener("restart", () => {
      alive = true;
      t.reset();
    });

    return () => {
      es.close();
      ro.disconnect();
      clearTimeout(resizeTimer);
      t.dispose();
      term.current = null;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focused) term.current?.t.focus();
  }, [focused]);
  useEffect(() => {
    const x = term.current;
    if (!x || x.t.options.fontSize === fontSize) return;
    x.t.options.fontSize = fontSize;
    x.fit.fit();
  }, [fontSize]);
  useEffect(() => {
    if (findReq) setFind((f) => f ?? "");
  }, [findReq]);
  useEffect(() => {
    if (find !== null) findInput.current?.select();
  }, [find !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (dir: 1 | -1, q = find ?? "") => {
    const s = term.current?.search;
    const opts = { decorations: { matchOverviewRuler: "#f5c26b", activeMatchColorOverviewRuler: "#8b93e6", matchBackground: "#f5c26b55", activeMatchBackground: "#8b93e6aa" } };
    if (q) (dir === 1 ? s?.findNext(q, opts) : s?.findPrevious(q, opts));
  };
  const closeFind = () => (setFind(null), term.current?.search.clearDecorations(), term.current?.t.focus());

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={host} className="h-full w-full overflow-hidden px-2 pt-1 pb-1" />
      {find !== null && (
        <div className="bg-popover/95 border-foreground/10 absolute top-2 right-3 z-10 flex items-center gap-1 rounded-lg border p-1 shadow-lg backdrop-blur">
          <Search className="text-muted-foreground ml-1 size-3.5" aria-hidden />
          <input
            ref={findInput}
            value={find}
            placeholder="Find…"
            aria-label="Find in terminal"
            className="w-40 bg-transparent px-1 text-xs outline-none"
            onChange={(e) => (setFind(e.target.value), go(1, e.target.value))}
            onKeyDown={(e) => (e.key === "Enter" ? (e.preventDefault(), go(e.shiftKey ? -1 : 1)) : e.key === "Escape" && closeFind())}
          />
          <Button size="icon-xs" variant="ghost" aria-label="Previous match" onClick={() => go(-1)}>
            <ChevronUp aria-hidden />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Next match" onClick={() => go(1)}>
            <ChevronDown aria-hidden />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={closeFind}>
            <X aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

/** Live state at a glance: pulsing = output right now, blue = new output you haven't looked at, red = crashed. */
function StatusDot({ t, unread, now }: { t: TermInfo; unread: boolean; now: number }) {
  const busy = t.alive && now - t.lastDataAt < 2000;
  const label = !t.alive ? `exited ${t.exitCode}` : busy ? "output now" : unread ? "new output" : "idle";
  return (
    <span className="relative flex size-2 shrink-0" title={label} aria-label={label} role="img">
      {busy && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />}
      <span className={cn("relative size-2 rounded-full", !t.alive ? (t.exitCode ? "bg-red-500" : "bg-muted-foreground/40") : unread ? "bg-primary" : "bg-emerald-500")} />
    </span>
  );
}

const openPort = (port: number) => window.open(`http://localhost:${port}`, "_blank", "noopener");
function PortChips({ ports, className }: { ports: number[]; className?: string }) {
  return ports.slice(0, 3).map((p) => (
    <button
      key={p}
      type="button"
      title={`Open http://localhost:${p}`}
      onClick={(e) => (e.stopPropagation(), openPort(p))}
      className={cn("shrink-0 rounded bg-sky-500/10 px-1 font-mono text-[10px] text-sky-500 hover:bg-sky-500/20 dark:text-sky-300", className)}
    >
      :{p}
    </button>
  ));
}

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const M = isMac ? "⌘" : "Ctrl+";
const SHORTCUTS: [string, string][] = [
  [`${M}T`, "New terminal in this folder"],
  [`${M}D`, "Split: new terminal beside this one"],
  [`${M}1…9`, "Jump to terminal"],
  [`${M}⇧[  ${M}⇧]`, "Previous / next terminal"],
  [`${M}⌥←  ${M}⌥→`, "Move between panes"],
  [`${M}⇧↵`, "Zoom pane"],
  [`${M}F`, "Find in terminal"],
  [`${M}E`, "Files panel for this folder (tree, viewer, git)"],
  [`${M}⇧E`, "Hide / show terminals (files only)"],
  [`${M}P`, "Go to file (files panel open)"],
  ["⌥-click / drag file", "Paste its path into the shell"],
  [`${M}⌥R`, "Restart shell (re-runs its command)"],
  [`${M}= / ${M}- / ${M}0`, "Font size"],
  [`${M}W`, "Close terminal (desktop)"],
  [`${M}-click / drag`, "Open in split"],
  ["Double-click", "Rename"],
];

function ShortcutList() {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-xs">
      {SHORTCUTS.map(([k, v]) => (
        <div key={k} className="contents">
          <dt>
            <Kbd className="font-mono">{k}</Kbd>
          </dt>
          <dd className="text-muted-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type Step = TerminalTemplateInput["steps"][number];
type KeyedStep = Step & { key: number };
let stepSeq = 0;
const blankStep = (workspaceId: string): KeyedStep => ({ key: ++stepSeq, workspaceId, title: "", command: "", delaySec: 0 });

function StepRow({ st, i, only, folderOptions, set, remove }: { st: KeyedStep; i: number; only: boolean; folderOptions: { value: string; label: string }[]; set: (p: Partial<Step>) => void; remove: () => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item value={st} dragListener={false} dragControls={controls} whileDrag={{ scale: 1.015, zIndex: 20 }} className="bg-foreground/[0.03] border-foreground/[0.07] bg-background grid gap-2 rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <button type="button" aria-label={`Drag to reorder step ${i + 1}`} onPointerDown={(e) => controls.start(e)} className="text-muted-foreground hover:text-foreground -ml-1 cursor-grab touch-none rounded p-0.5 active:cursor-grabbing">
          <GripVertical className="size-4" aria-hidden />
        </button>
        <span className="text-muted-foreground w-4 shrink-0 font-mono text-xs">{i + 1}.</span>
        <OptionSelect label="Folder" size="sm" value={st.workspaceId} onChange={(v) => set({ workspaceId: v })} options={folderOptions} className="flex-1" />
        <Input className="h-7 flex-1 text-xs" value={st.title} onChange={(e) => set({ title: e.target.value })} placeholder="Name (optional)" aria-label="Terminal name" />
        <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove step" disabled={only} onClick={remove}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input className="h-7 flex-1 font-mono text-xs" value={st.command} onChange={(e) => set({ command: e.target.value })} placeholder="Command to run (optional), e.g. pnpm dev" aria-label="Command" />
        <label className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
          wait
          <Input type="number" min={0} max={600} className="h-7 w-16 text-xs tabular-nums" value={st.delaySec} onChange={(e) => set({ delaySec: Math.max(0, Math.min(600, Number(e.target.value) || 0)) })} aria-label="Seconds to wait before running the command" />
          s
        </label>
      </div>
    </Reorder.Item>
  );
}

/** Create/edit a template: ordered steps of folder + optional name + optional command + optional delay. */
function TemplateDialog({ orgId, workspaces, initial, seed, onClose }: { orgId: string; workspaces: Workspace[]; initial: TerminalTemplate | null; seed?: Step[]; onClose: () => void }) {
  const key = keys.res(orgId, "terminal-templates");
  const [name, setName] = useState(initial?.name ?? "");
  const [steps, setSteps] = useState<KeyedStep[]>(() => (initial || seed ? (initial?.steps ?? seed!).map((st) => ({ ...blankStep(st.workspaceId), ...st, key: ++stepSeq })) : [blankStep(workspaces[0]?.id ?? "")]));
  const save = useApiMutation((v: TerminalTemplateInput) => (initial ? api.patch(`/terminal-templates/${initial.id}`, v) : api.post(`/orgs/${orgId}/terminal-templates`, v)), [key]);
  const folderOptions = workspaces.map((w) => ({ value: w.id, label: w.name }));
  const valid = name.trim() && steps.length > 0 && steps.every((st) => st.workspaceId);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit template" : "New terminal template"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutateAsync({ name, steps: steps.map(({ key: _k, ...st }) => st) }).then(onClose);
          }}
        >
          <Field label="Template name">{(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Full stack dev" />}</Field>
          <div className="grid gap-2">
            <p className="text-[13px] font-medium">Terminals to open</p>
            <p className="text-muted-foreground -mt-1 text-xs">All shells open at once. "wait" delays only that step's command, e.g. give the db 5s before the server starts.</p>
            <Reorder.Group axis="y" values={steps} onReorder={setSteps} className="grid gap-2">
              {steps.map((st, i) => (
                <StepRow key={st.key} st={st} i={i} only={steps.length === 1} folderOptions={folderOptions} set={(patch) => setSteps((ss) => ss.map((x) => (x.key === st.key ? { ...x, ...patch } : x)))} remove={() => setSteps((ss) => ss.filter((x) => x.key !== st.key))} />
              ))}
            </Reorder.Group>
            <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setSteps((ss) => [...ss, blankStep(ss.at(-1)?.workspaceId ?? workspaces[0]?.id ?? "")])}>
              <Plus aria-hidden /> Add terminal
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {initial ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TerminalsPage() {
  const org = useOrg();
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const key = keys.res(org.id, "terminals");
  // Polled while this page is open: drives the busy / unread / crashed dots and the foreground process name.
  const { data: terms = [], isSuccess } = useQuery({ queryKey: key, queryFn: () => api.get<TermInfo[]>(`/orgs/${org.id}/terminals`), refetchInterval: 1500 });
  const { data: ports = [] } = useQuery({ queryKey: ["system", "ports"], queryFn: () => api.get<PortInfo[]>("/system/ports"), refetchInterval: 5000, enabled: terms.some((t) => t.alive) });
  const portsOf = (tid: string) => [...new Set(ports.filter((p) => p.terminalId === tid).map((p) => p.port))].sort((a, b) => a - b);
  const spawn = useApiMutation((v: { workspaceId: string; command?: string }) => api.post<TermInfo>(`/workspaces/${v.workspaceId}/terminals`, { command: v.command }, true), [key]);
  const close = useApiMutation((termId: string) => api.del(`/terminals/${termId}`), [key]);
  const restartM = useApiMutation((termId: string) => api.post<TermInfo>(`/terminals/${termId}/restart`, {}, true), [key]);
  const rename = useApiMutation((v: { id: string; title: string }) => api.patch(`/terminals/${v.id}`, { title: v.title }, true), [key]);
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [folded, setFolded] = useState<Record<string, boolean>>({}); // ponytail: in-memory fold state; persist if it ever annoys
  const [hidden, setHidden] = useState(() => store.get("zippy-term-rail") === "1");
  const toggleRail = () => setHidden((h) => (store.set("zippy-term-rail", h ? "0" : "1"), !h));
  const [fontSize, setFontSize] = useState(() => Number(store.get("zippy-term-font")) || 12);
  const font = (n: number) => setFontSize(() => (store.set("zippy-term-font", String(n)), n));
  const [zoomed, setZoomed] = useState(false);
  const [findReq, setFindReq] = useState(0);
  // Files panel: tree + viewer + git for the focused pane's folder, beside the shells.
  const [files, setFiles] = useState(() => store.get("zippy-term-files") === "1");
  const toggleFiles = () => setFiles((f) => (store.set("zippy-term-files", f ? "0" : "1"), !f));
  // Either section can go away, never both: hiding the shells turns files on, hiding files turns shells on.
  const [shells, setShells] = useState(() => store.get("zippy-term-shells") !== "0");
  const toggleShells = () => setShells((s) => (store.set("zippy-term-shells", s ? "0" : "1"), s && setFiles(() => (store.set("zippy-term-files", "1"), true)), !s));
  const hideFiles = () => (setFiles(() => (store.set("zippy-term-files", "0"), false)), setShells(() => (store.set("zippy-term-shells", "1"), true)));
  // Files-only mode has no focused pane to follow, so the header gets a folder picker; the pick lasts until focus moves.
  const [pickedWs, setPickedWs] = useState<{ ws: string; under: string | undefined } | null>(null);
  const filesLayout = useDefaultLayout({ id: "term-files", storage: localStorage });
  const [helpOpen, setHelpOpen] = useState(false);
  const { data: templates = [] } = useTerminalTemplates(org.id);
  const tkey = keys.res(org.id, "terminal-templates");
  const [tplDialog, setTplDialog] = useState<{ open: boolean; edit: TerminalTemplate | null; seed?: TerminalTemplateInput["steps"] }>({ open: false, edit: null });
  const [tplFolded, setTplFolded] = useState(false);
  const runTpl = useApiMutation((tplId: string) => api.post<TermInfo[]>(`/terminal-templates/${tplId}/run`, {}, true), [key]);
  const delTpl = useApiMutation((tplId: string) => api.del(`/terminal-templates/${tplId}`), [tkey]);

  // Panes: the terminals on screen, left→right / top→bottom. The URL id is the focused one.
  const [panes, setPanesRaw] = useState<string[]>(() => JSON.parse(store.get("zippy-term-panes") ?? "[]"));
  const setPanes = (f: (p: string[]) => string[]) => setPanesRaw((p) => {
    const n = f(p);
    store.set("zippy-term-panes", JSON.stringify(n));
    return n;
  });
  const live = isSuccess ? panes.filter((p) => terms.some((t) => t.id === p)) : panes;
  const current = terms.find((t) => t.id === id);
  const lastIdx = useRef(0);
  if (id && live.includes(id)) lastIdx.current = live.indexOf(id);

  // Flat sidebar order: ⌘1…9 and ⌘⇧[ ] follow it.
  const ordered = workspaces.flatMap((w) => terms.filter((t) => t.workspaceId === w.id));
  const wsName = (wid: string) => workspaces.find((w) => w.id === wid)?.name ?? "";

  /** Show a terminal: focus it if on screen, add it as a split, or swap it into the focused pane. */
  const show = (tid: string, split = false) => {
    if (!live.includes(tid))
      setPanes(() => (split && live.length < MAX_PANES ? [...live, tid] : live.length ? live.map((x, i) => (i === Math.min(lastIdx.current, live.length - 1) ? tid : x)) : [tid]));
    if (split) setZoomed(false);
    navigate(`/terminals/${tid}`);
  };
  // Arriving from elsewhere (palette, Ports page, back button) with an id that isn't on screen.
  useEffect(() => {
    if (id && isSuccess && terms.some((t) => t.id === id) && !live.includes(id)) show(id);
    else if (!id && live.length) navigate(`/terminals/${live[0]}`, { replace: true });
  }, [id, isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTerms = (opened: TermInfo[]) => qc.setQueryData<TermInfo[]>(key, (ts = []) => [...ts, ...opened.filter((t) => !ts.some((x) => x.id === t.id))]);
  const open = (workspaceId: string, split = false, command?: string) => spawn.mutateAsync({ workspaceId, command }).then((t) => (addTerms([t]), show(t.id, split)));
  const restart = (tid: string) => restartM.mutate(tid);
  const kill = (t: TermInfo) =>
    close.mutateAsync(t.id).then(() => {
      if (t.id !== id) return;
      const rest = live.filter((x) => x !== t.id);
      const next = rest[Math.min(live.indexOf(t.id), rest.length - 1)];
      navigate(next ? `/terminals/${next}` : "/terminals");
    });
  const unsplit = (tid: string) => {
    const rest = live.filter((x) => x !== tid);
    setPanes(() => rest);
    if (tid === id) navigate(rest.length ? `/terminals/${rest[Math.min(live.indexOf(tid), rest.length - 1)]}` : "/terminals");
  };
  const clearExited = () => terms.filter((t) => !t.alive).forEach((t) => void kill(t));
  /** Type a file path (plus a trailing space) into a shell; defaults to the focused one. */
  const pastePath = (path: string, tid = id) => {
    const t = terms.find((x) => x.id === tid);
    if (!t?.alive) return void toast.error("Focus a running terminal first");
    // A filename holding \n or \x1b would type a newline / escape sequence into the shell: never forward raw control bytes.
    if (/[\x00-\x1f\x7f]/.test(path)) return void toast.error("Path contains control characters");
    void api.post(`/terminals/${t.id}/input`, { data: `${shellQuote(path.startsWith("-") ? `./${path}` : path)} ` }, true).catch((e: Error) => toast.error(e.message));
  };

  // Unread: output that arrived while a terminal was off screen. The first sighting is the baseline so a shell's startup prompt doesn't count.
  const seen = useRef<Record<string, number>>({});
  const now = Date.now();
  for (const t of terms) if (live.includes(t.id) || seen.current[t.id] === undefined) seen.current[t.id] = t.lastDataAt;
  const unread = (t: TermInfo) => !live.includes(t.id) && t.lastDataAt > seen.current[t.id]! + 500;

  // A background shell that crashes gets a toast; the visible ones already show it inline.
  const wasAlive = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const t of terms) {
      if (wasAlive.current[t.id] && !t.alive && t.exitCode && !live.includes(t.id))
        toast.error(`${t.title} exited with code ${t.exitCode}`, { description: wsName(t.workspaceId), action: { label: "Show", onClick: () => show(t.id) } });
      wasAlive.current[t.id] = t.alive;
    }
  }, [terms]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘W on this page kills the active shell instead of closing the window.
  useEffect(() => {
    if (!current) return;
    const on = (e: Event) => {
      e.preventDefault();
      void kill(current);
    };
    window.addEventListener("zippy:close", on);
    return () => window.removeEventListener("zippy:close", on);
  }, [current?.id, live.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard map. Capture phase so a focused xterm doesn't swallow these first.
  const keyState = useRef({ ordered, live, current, workspaces, fontSize, open, show, restart, font, toggleFiles, toggleShells });
  keyState.current = { ordered, live, current, workspaces, fontSize, open, show, restart, font, toggleFiles, toggleShells };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target as HTMLElement).closest("[role=dialog],[cmdk-root]")) return;
      const { ordered, live, current, workspaces, fontSize, open, show, restart, font, toggleFiles, toggleShells } = keyState.current;
      const folder = current?.workspaceId ?? workspaces[0]?.id;
      const k = e.key.toLowerCase();
      let hit = true;
      if (k === "t" && !e.shiftKey && folder) void open(folder);
      else if (k === "d" && !e.shiftKey && folder) void open(folder, live.length < MAX_PANES);
      else if (k === "e" && !e.altKey) (e.shiftKey ? toggleShells() : toggleFiles());
      else if (/^[1-9]$/.test(e.key) && !e.altKey && !e.shiftKey && ordered[+e.key - 1]) show(ordered[+e.key - 1]!.id);
      else if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight") && ordered.length) {
        const i = ordered.findIndex((t) => t.id === current?.id);
        show(ordered[(i + (e.code === "BracketRight" ? 1 : -1) + ordered.length) % ordered.length]!.id);
      } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && live.length > 1) {
        const i = live.indexOf(current?.id ?? "");
        navigate(`/terminals/${live[(i + (e.key === "ArrowRight" ? 1 : -1) + live.length) % live.length]}`);
      } else if (e.shiftKey && e.key === "Enter" && current) setZoomed((z) => !z);
      else if (e.altKey && e.code === "KeyR" && current) restart(current.id);
      else if (e.key === "=" || e.key === "+") font(Math.min(24, fontSize + 1));
      else if (e.key === "-") font(Math.max(9, fontSize - 1));
      else if (e.key === "0") font(12);
      else hit = false;
      if (hit) (e.preventDefault(), e.stopPropagation());
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveLayout = () =>
    setTplDialog({ open: true, edit: null, seed: live.map((pid) => terms.find((t) => t.id === pid)!).map((t) => ({ workspaceId: t.workspaceId, title: t.title, command: t.command, delaySec: 0 })) });
  const runTemplate = (tplId: string) =>
    runTpl.mutateAsync(tplId).then((opened) => {
      if (!opened.length) return;
      addTerms(opened);
      setPanes(() => opened.slice(0, MAX_PANES).map((t) => t.id));
      setZoomed(false);
      navigate(`/terminals/${opened[0]!.id}`);
    });

  const needle = q.trim().toLowerCase();
  const hit = (t: TermInfo, w: { name: string }) => !needle || [t.title, w.name, t.process, t.command, ...portsOf(t.id).map(String)].some((s) => s.toLowerCase().includes(needle));
  const shown = zoomed && current && live.includes(current.id) ? [current.id] : live;
  const n = shown.length;
  const filesWs = workspaces.find((w) => w.id === ((pickedWs && pickedWs.under === id ? pickedWs.ws : undefined) ?? current?.workspaceId ?? workspaces[0]?.id));
  const [dropping, setDropping] = useState<string | null>(null);

  const row = (t: TermInfo) => {
    const idx = ordered.indexOf(t);
    const onScreen = live.includes(t.id);
    const proc = t.process && !SHELLS.has(t.process) ? t.process : null;
    return (
      <div
        key={t.id}
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/zippy-term", t.id)}
        className={cn(
          "group/t hover:bg-foreground/[0.05] relative flex items-center gap-2 rounded-lg pr-1 pl-2 text-[13px]",
          t.id === id ? "bg-foreground/[0.08]" : onScreen && "bg-foreground/[0.03]",
        )}
      >
        {onScreen && <span className={cn("absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full", t.id === id ? "bg-primary" : "bg-foreground/20")} aria-hidden />}
        {editing === t.id ? (
          <input
            autoFocus
            defaultValue={t.title}
            aria-label="Terminal name"
            className="my-1 min-w-0 flex-1 rounded border-0 bg-transparent px-0 font-mono text-xs outline-none"
            onBlur={(e) => {
              const title = e.currentTarget.value.trim();
              if (title && title !== t.title) rename.mutate({ id: t.id, title });
              setEditing(null);
            }}
            onKeyDown={(e) => (e.key === "Enter" && e.currentTarget.blur(), e.key === "Escape" && ((e.currentTarget.value = t.title), e.currentTarget.blur()))}
          />
        ) : (
          <button
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            title={`${t.command ? `$ ${t.command}\n` : ""}Double-click to rename · ${M}-click to split`}
            onClick={(e) => show(t.id, e.metaKey || e.ctrlKey)}
            onDoubleClick={() => setEditing(t.id)}
          >
            <StatusDot t={t} unread={unread(t)} now={now} />
            <span className={cn("truncate font-mono text-xs", unread(t) && "text-foreground font-semibold")}>{t.title}</span>
            {proc && <span className="text-muted-foreground shrink-0 truncate font-mono text-[10px]">{proc}</span>}
            {!t.alive && <span className={cn("shrink-0 text-[10px]", t.exitCode ? "text-red-500" : "text-muted-foreground")}>exit {t.exitCode}</span>}
          </button>
        )}
        <PortChips ports={portsOf(t.id)} />
        {idx < 9 && <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px] group-hover/t:hidden">{M}{idx + 1}</span>}
        <span className="hidden shrink-0 items-center group-hover/t:flex group-focus-within/t:flex">
          {!onScreen && live.length < MAX_PANES && (
            <button aria-label={`Open ${t.title} in split`} title="Open in split" onClick={() => show(t.id, true)} className="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded">
              <Columns2 className="size-3.5" aria-hidden />
            </button>
          )}
          <button aria-label={`Close ${t.title}`} title="Close" onClick={() => kill(t)} className="text-muted-foreground hover:text-destructive flex size-5 items-center justify-center rounded">
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className={cn("border-foreground/[0.07] flex shrink-0 flex-col gap-3 overflow-y-auto border-r py-4 transition-[width] duration-150", hidden ? "w-11 items-center px-1" : "w-64 px-3")} aria-label="Terminals">
        <div className={cn("flex items-center", hidden ? "justify-center" : "justify-between px-1")}>
          {!hidden && <h1 className="text-[15px] font-semibold tracking-tight">Terminals</h1>}
          <div className="flex items-center">
            {!hidden && terms.some((t) => !t.alive) && (
              <Button size="icon-xs" variant="ghost" aria-label="Close exited terminals" title="Close exited terminals" onClick={clearExited}>
                <Eraser aria-hidden />
              </Button>
            )}
            {!hidden && workspaces.length > 0 && (
              <Button size="icon-xs" variant="ghost" aria-label={files ? "Hide files panel" : "Show files panel"} aria-pressed={files} title={`Files panel (${M}E)`} onClick={toggleFiles} className={cn(files && "bg-foreground/[0.08]")}>
                <FolderOpen aria-hidden />
              </Button>
            )}
            {!hidden && (
              <Popover open={helpOpen} onOpenChange={setHelpOpen}>
                <PopoverTrigger asChild>
                  <Button size="icon-xs" variant="ghost" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
                    <Keyboard aria-hidden />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80">
                  <p className="mb-3 text-[13px] font-medium">Shortcuts</p>
                  <ShortcutList />
                </PopoverContent>
              </Popover>
            )}
            <Button size="icon-xs" variant="ghost" aria-label={hidden ? "Show terminal list" : "Hide terminal list"} onClick={toggleRail}>
              {hidden ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            </Button>
          </div>
        </div>
        {hidden ? (
          ordered.map((t) => (
            <button key={t.id} title={t.title} aria-label={t.title} onClick={(e) => show(t.id, e.metaKey || e.ctrlKey)} className={cn("hover:bg-foreground/[0.06] flex size-8 items-center justify-center rounded-lg", t.id === id ? "bg-foreground/[0.1]" : live.includes(t.id) && "bg-foreground/[0.04]")}>
              <StatusDot t={t} unread={unread(t)} now={now} />
            </button>
          ))
        ) : (
          <>
            <label className="border-foreground/[0.07] bg-background/40 focus-within:border-primary/40 flex h-8 items-center gap-2 rounded-lg border px-2">
              <Search className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, folder, process, port…" aria-label="Search sessions" className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none" />
              {q && (
                <button aria-label="Clear search" onClick={() => setQ("")} className="text-muted-foreground hover:text-foreground">
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </label>
            {!needle && (
              <section className="grid gap-0.5">
                <div className="flex items-center justify-between px-1">
                  <button onClick={() => setTplFolded((f) => !f)} aria-expanded={!tplFolded} className="text-muted-foreground/80 hover:text-foreground flex min-w-0 items-center gap-1 font-mono text-[10px] font-medium tracking-[0.14em] uppercase">
                    <ChevronDown className={cn("size-3 shrink-0 transition-transform", tplFolded && "-rotate-90")} aria-hidden />
                    Templates
                  </button>
                  <div className="flex items-center">
                    {live.length > 0 && (
                      <Button size="icon-xs" variant="ghost" aria-label="Save open panes as a template" title="Save open panes as a template" onClick={saveLayout}>
                        <BookmarkPlus aria-hidden />
                      </Button>
                    )}
                    <Button size="icon-xs" variant="ghost" aria-label="New template" title="New template" onClick={() => setTplDialog({ open: true, edit: null })} disabled={!workspaces.length}>
                      <Plus aria-hidden />
                    </Button>
                  </div>
                </div>
                {!tplFolded &&
                  templates.map((tpl) => (
                    <div key={tpl.id} className="group/p hover:bg-foreground/[0.05] flex items-center gap-1 rounded-lg pr-1 pl-2 text-[13px]">
                      <button className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left" title={tpl.steps.map((st) => (st.command || "shell") + (st.delaySec ? ` (+${st.delaySec}s)` : "")).join(" · ")} onClick={() => runTemplate(tpl.id)} disabled={runTpl.isPending}>
                        <Play className="text-primary size-3 shrink-0 fill-current" aria-hidden />
                        <span className="truncate text-xs">{tpl.name}</span>
                        <span className="text-muted-foreground shrink-0 text-[10px]">{tpl.steps.length}</span>
                      </button>
                      <button aria-label={`Edit ${tpl.name}`} onClick={() => setTplDialog({ open: true, edit: tpl })} className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded opacity-0 group-hover/p:opacity-100 focus-visible:opacity-100">
                        <Pencil className="size-3" aria-hidden />
                      </button>
                      <button aria-label={`Delete ${tpl.name}`} onClick={() => delTpl.mutate(tpl.id)} className="text-muted-foreground hover:text-destructive flex size-5 shrink-0 items-center justify-center rounded opacity-0 group-hover/p:opacity-100 focus-visible:opacity-100">
                        <Trash2 className="size-3" aria-hidden />
                      </button>
                    </div>
                  ))}
                {!tplFolded && !templates.length && (
                  <button onClick={() => (live.length ? saveLayout() : setTplDialog({ open: true, edit: null }))} disabled={!workspaces.length} className="text-muted-foreground hover:text-foreground px-2 py-1 text-left text-xs">
                    {live.length ? "+ Save these panes to reopen in one click" : "+ Save a set of shells to reopen in one click"}
                  </button>
                )}
              </section>
            )}
            {workspaces.map((w) => {
              const mine = terms.filter((t) => t.workspaceId === w.id && hit(t, w));
              if (needle && !mine.length) return null;
              const open_ = needle ? true : !folded[w.id];
              const attention = !open_ && mine.some((t) => unread(t) || (!t.alive && t.exitCode));
              return (
                <section key={w.id} className="grid gap-0.5">
                  <div className="flex items-center justify-between px-1">
                    <button onClick={() => setFolded((f) => ({ ...f, [w.id]: !f[w.id] }))} aria-expanded={open_} className="text-muted-foreground/80 hover:text-foreground flex min-w-0 items-center gap-1 font-mono text-[10px] font-medium tracking-[0.14em] uppercase">
                      <ChevronDown className={cn("size-3 shrink-0 transition-transform", !open_ && "-rotate-90")} aria-hidden />
                      <span className="truncate">{w.name}</span>
                      {!open_ && mine.length > 0 && <span className="text-muted-foreground/60 ml-1 normal-case tracking-normal">{mine.length}</span>}
                      {attention && <span className="bg-primary ml-1 size-1.5 rounded-full" aria-label="new output" />}
                    </button>
                    <Button size="icon-xs" variant="ghost" aria-label={`New terminal in ${w.name}`} title={`New terminal in ${w.name} (${M}-click to split)`} onClick={(e) => open(w.id, e.metaKey || e.ctrlKey)} disabled={spawn.isPending}>
                      <Plus aria-hidden />
                    </Button>
                  </div>
                  {open_ && mine.map(row)}
                  {open_ && !mine.length && (
                    <button onClick={() => open(w.id)} className="text-muted-foreground hover:text-foreground px-2 py-1 text-left text-xs">
                      + Open shell
                    </button>
                  )}
                </section>
              );
            })}
            {needle && !terms.some((t) => hit(t, workspaces.find((w) => w.id === t.workspaceId) ?? { name: "" })) && <p className="text-muted-foreground px-1 text-xs">No sessions match.</p>}
            {!workspaces.length && <p className="text-muted-foreground px-1 text-xs">Add a working folder first.</p>}
          </>
        )}
      </aside>
      {tplDialog.open && <TemplateDialog orgId={org.id} workspaces={workspaces} initial={tplDialog.edit} seed={tplDialog.seed} onClose={() => setTplDialog({ open: false, edit: null })} />}
      <Group orientation="horizontal" id="term-files" defaultLayout={filesLayout.defaultLayout} onLayoutChanged={filesLayout.onLayoutChanged} className="min-h-0 min-w-0 flex-1">
      {shells && (
      <Panel id="panes" minSize="30%">
      <div
        className="grid h-full min-h-0 min-w-0 gap-2 p-2"
        style={{ gridTemplateColumns: `repeat(${n <= 1 ? 1 : n <= 4 ? 2 : 3}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${n <= 2 ? 1 : 2}, minmax(0, 1fr))` }}
        onDragOver={(e) => e.dataTransfer.types.includes("text/zippy-term") && e.preventDefault()}
        onDrop={(e) => {
          const tid = e.dataTransfer.getData("text/zippy-term");
          if (tid) show(tid, true);
        }}
      >
        {n ? (
          live.map((pid, i) => {
            const t = terms.find((x) => x.id === pid);
            if (!t) return null;
            const focused = t.id === id;
            const proc = t.process && !SHELLS.has(t.process) ? t.process : null;
            return (
              <section
                key={pid}
                aria-label={t.title}
                className={cn(
                  "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-[#0f0f10] ring-1 transition-shadow",
                  focused && n > 1 ? "ring-primary/70" : "ring-white/[0.06]",
                  !shown.includes(pid) && "hidden",
                  n % 2 === 1 && n > 1 && i === 0 && "row-span-2",
                  dropping === pid && "ring-primary ring-2",
                )}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("text/zippy-path")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (dropping !== pid) setDropping(pid);
                }}
                onDragLeave={() => dropping === pid && setDropping(null)}
                onDrop={(e) => {
                  const p = e.dataTransfer.getData("text/zippy-path");
                  if (!p) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropping(null);
                  pastePath(p, pid);
                  navigate(`/terminals/${pid}`);
                }}
              >
                <header className="group/h flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 font-mono text-[11px] text-white/50" onClick={() => !focused && navigate(`/terminals/${pid}`)}>
                  <StatusDot t={t} unread={false} now={now} />
                  {editing === `pane:${t.id}` ? (
                    <input
                      autoFocus
                      defaultValue={t.title}
                      aria-label="Terminal name"
                      className="min-w-0 flex-1 bg-transparent text-white/90 outline-none"
                      onBlur={(e) => {
                        const title = e.currentTarget.value.trim();
                        if (title && title !== t.title) rename.mutate({ id: t.id, title });
                        setEditing(null);
                      }}
                      onKeyDown={(e) => (e.key === "Enter" && e.currentTarget.blur(), e.key === "Escape" && ((e.currentTarget.value = t.title), e.currentTarget.blur()))}
                    />
                  ) : (
                    <span className={cn("truncate", focused ? "text-white/90" : "text-white/60")} onDoubleClick={() => setEditing(`pane:${t.id}`)} title="Double-click to rename">
                      {t.title}
                    </span>
                  )}
                  <span className="truncate">{wsName(t.workspaceId)}</span>
                  {proc && <span className="shrink-0 rounded bg-white/[0.06] px-1 text-white/70">{proc}</span>}
                  {!t.alive && <span className={cn("shrink-0", t.exitCode ? "text-red-400" : "")}>exit {t.exitCode}</span>}
                  <PortChips ports={portsOf(t.id)} className="text-sky-300" />
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/h:opacity-100 focus-within:opacity-100">
                    <PaneBtn label={`${files && focused ? "Hide" : "Show"} files for ${wsName(t.workspaceId)} (${M}E)`} onClick={() => (navigate(`/terminals/${pid}`), (!files || focused) && toggleFiles())} icon={FolderOpen} active={files && focused} />
                    <PaneBtn label={`Find (${M}F)`} onClick={() => (navigate(`/terminals/${pid}`), setFindReq((x) => x + 1))} icon={Search} />
                    <PaneBtn label={`Restart${t.command ? ` and re-run "${t.command}"` : ""} (${M}⌥R)`} onClick={() => restart(t.id)} icon={RotateCw} />
                    {live.length < MAX_PANES && <PaneBtn label={`Split (${M}D)`} onClick={() => open(t.workspaceId, true)} icon={Columns2} />}
                    {n > 1 || zoomed ? <PaneBtn label={`${zoomed ? "Unzoom" : "Zoom"} (${M}⇧↵)`} onClick={() => (navigate(`/terminals/${pid}`), setZoomed((z) => !z))} icon={zoomed ? Minimize2 : Maximize2} /> : null}
                    {live.length > 1 && <PaneBtn label="Remove from view (keeps running)" onClick={() => unsplit(pid)} icon={SquareX} />}
                    <PaneBtn label="Close terminal" onClick={() => kill(t)} icon={X} danger />
                  </span>
                </header>
                <PtyTerminal id={pid} focused={focused} fontSize={fontSize} findReq={focused ? findReq : 0} onFocus={() => !focused && navigate(`/terminals/${pid}`)} onRestart={() => restart(pid)} />
              </section>
            );
          })
        ) : (
          <EmptyState workspaces={workspaces} templates={templates} onOpen={(wid) => open(wid)} onRun={runTemplate} hasTerms={terms.length > 0} />
        )}
      </div>
      </Panel>
      )}
      {files && filesWs && (
        <>
          {shells && <Separator className="bg-border hover:bg-primary focus-visible:bg-primary relative w-px outline-none transition-colors after:absolute after:inset-y-0 after:-inset-x-1" />}
          <Panel id="files" minSize="22%" defaultSize="38%" className="min-w-0">
            <motion.div key={filesWs.id} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18, ease: "easeOut" }} className="flex h-full min-h-0 flex-col">
              <header className="border-foreground/[0.07] flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
                <FolderOpen className="text-primary size-3.5 shrink-0" aria-hidden />
                {shells && pickedWs?.under !== id ? (
                  <>
                    <span className="truncate font-medium">{filesWs.name}</span>
                    <span className="text-muted-foreground truncate">{current ? `follows ${current.title}` : "no terminal focused"}</span>
                  </>
                ) : (
                  <OptionSelect label="Folder" size="sm" value={filesWs.id} onChange={(ws) => setPickedWs({ ws, under: id })} options={workspaces.map((w) => ({ value: w.id, label: w.name }))} className="h-6 max-w-64 text-xs" />
                )}
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                  <Button size="icon-xs" variant="ghost" aria-label={shells ? "Hide terminals, files only" : "Show terminals"} aria-pressed={!shells} title={`${shells ? "Files only" : "Show terminals"} (${M}⇧E)`} onClick={toggleShells} className={cn(!shells && "bg-foreground/[0.08]")}>
                    {shells ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
                  </Button>
                  <Button size="icon-xs" variant="ghost" aria-label="Close files panel" title={`Close files (${M}E)`} onClick={hideFiles}>
                    <X aria-hidden />
                  </Button>
                </span>
              </header>
              <FileBrowser id={filesWs.id} compact={shells} onPath={(p) => pastePath(p)} />
            </motion.div>
          </Panel>
        </>
      )}
      </Group>
    </div>
  );
}

function PaneBtn({ label, onClick, icon: Icon, danger, active }: { label: string; onClick: () => void; icon: typeof X; danger?: boolean; active?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={(e) => (e.stopPropagation(), onClick())} className={cn("flex size-6 items-center justify-center rounded text-white/50 hover:bg-white/[0.08]", danger ? "hover:text-red-400" : "hover:text-white", active && "bg-white/[0.08] text-white")}>
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}

function EmptyState({ workspaces, templates, onOpen, onRun, hasTerms }: { workspaces: Workspace[]; templates: TerminalTemplate[]; onOpen: (wid: string) => void; onRun: (tid: string) => void; hasTerms: boolean }) {
  return (
    <div className="m-auto grid w-full max-w-xl gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{hasTerms ? "Pick a terminal" : "Open a terminal"}</h2>
        <p className="text-muted-foreground mt-1 text-[13px]">{hasTerms ? `Click one on the left, ${M}-click or drag it here to split.` : "Shells run on this machine in your working folders and keep running while you're on other pages."}</p>
      </div>
      {templates.length > 0 && (
        <div className="grid gap-2">
          <p className="text-muted-foreground font-mono text-[10px] font-medium tracking-[0.14em] uppercase">Templates</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <Button key={t.id} variant="outline" size="sm" onClick={() => onRun(t.id)}>
                <Play className="text-primary fill-current" aria-hidden /> {t.name}
                <span className="text-muted-foreground text-[10px]">{t.steps.length}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
      {workspaces.length > 0 && (
        <div className="grid gap-2">
          <p className="text-muted-foreground font-mono text-[10px] font-medium tracking-[0.14em] uppercase">New shell in</p>
          <div className="flex flex-wrap gap-2">
            {workspaces.map((w) => (
              <Button key={w.id} variant="outline" size="sm" onClick={() => onOpen(w.id)}>
                <Plus aria-hidden /> {w.name}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="border-foreground/[0.07] rounded-xl border p-4">
        <ShortcutList />
      </div>
    </div>
  );
}
