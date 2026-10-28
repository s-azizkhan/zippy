import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { BookmarkPlus, ChevronDown, ChevronLeft, ChevronUp, Columns2, Eraser, FilePlus2, Folder, FolderOpen, GitBranch, GripVertical, History, Keyboard, ListChecks, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RotateCw, Search, ShieldOff, SquareX, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, MotionConfig, Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useLocation, useNavigate, useParams } from "react-router";
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
import { api, keys, useApiMutation, useTerminalTemplates, useWorkspaces, type ClaudeSession, type TermInfo } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { PortInfo } from "@/pages/ports";

const MAX_PANES = 6;
// Phone: list and terminal are separate screens, one pane at a time, plus a key bar for keys a phone keyboard lacks.
const phoneMq = matchMedia("(max-width: 47.99rem)");
const usePhone = () => useSyncExternalStore((cb) => (phoneMq.addEventListener("change", cb), () => phoneMq.removeEventListener("change", cb)), () => phoneMq.matches);
const KEYS: [string, string][] = [["esc", "\x1b"], ["tab", "\t"], ["^C", "\x03"], ["^D", "\x04"], ["^L", "\x0c"], ["^R", "\x12"], ["←", "\x1b[D"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["→", "\x1b[C"], ["|", "|"], ["~", "~"], ["/", "/"], ["-", "-"]];
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
/** Selection, or the last `lines` non-empty rows when nothing is selected. */
export type TermTextRef = { current: Record<string, (lines: number) => string> };

function PtyTerminal({ id, focused, fontSize, findReq, onFocus, onRestart, onFiles, textRef, roomy }: { id: string; focused: boolean; fontSize: number; findReq: number; onFocus: () => void; onRestart: () => void; onFiles: (files: File[]) => void; textRef: TermTextRef; roomy?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ t: XTerm; fit: FitAddon; search: SearchAddon } | null>(null);
  const cb = useRef({ onFocus, onRestart, onFiles });
  cb.current = { onFocus, onRestart, onFiles };
  const [find, setFind] = useState<string | null>(null);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = host.current!;
    const t = new XTerm({ cursorBlink: true, fontSize, lineHeight: 1.15, fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace', scrollback: 10_000, allowProposedApi: true, theme: THEME });
    const fit = new FitAddon();
    const search = new SearchAddon();
    t.loadAddon(fit);
    t.loadAddon(search);
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")));
    t.open(el);
    term.current = { t, fit, search };
    const getters = textRef.current;
    getters[id] = (lines) => {
      const sel = t.getSelection().trim();
      if (sel) return sel;
      const b = t.buffer.active;
      const rows: string[] = [];
      for (let i = b.length - 1; i >= 0 && rows.length < lines; i--) rows.unshift(b.getLine(i)?.translateToString(true) ?? "");
      return rows.join("\n").trim();
    };
    t.textarea?.addEventListener("focus", () => cb.current.onFocus());
    // ⌘V of a screenshot: xterm only pastes text, so upload the image and type its path (Claude attaches image paths as images).
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current.onFiles(files);
    };
    el.addEventListener("paste", paste, true);
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
    const post = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void api.post(`/terminals/${id}/resize`, { cols: t.cols, rows: t.rows }, true).catch(() => {}), 80);
    };
    const resize = () => {
      if (!el.offsetWidth) return; // hidden (another pane is zoomed)
      fit.fit();
      post();
    };
    t.onResize(post); // font size changes refit without the host resizing
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
      el.removeEventListener("paste", paste, true);
      delete getters[id];
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
      <div ref={host} className={cn("h-full w-full overflow-hidden max-md:px-1", roomy ? "px-3.5 pt-2.5 pb-1.5" : "px-2 pt-1 pb-1")} />
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

/** Who a shell belongs to: @zipper and ticket tags. Click opens the Zipper or ticket; × untags (pane header only). */
function TagChips({ t, onRemove, className }: { t: TermInfo; onRemove?: (tag: string) => void; className?: string }) {
  const navigate = useNavigate();
  if (!t.tags.length) return null;
  const firstTicket = t.tags.find((x) => !x.startsWith("@"));
  const to = (tag: string) => (tag.startsWith("@") ? `/zippers/${tag.slice(1)}` : t.ticketKind === "chat" && t.ticketId && tag === firstTicket ? `/chat/${t.ticketId}` : `/t/${tag}`);
  return (
    <span className={cn("flex min-w-0 shrink items-center gap-1", className)}>
      {t.tags.map((tag) => (
        <span key={tag} className="group/tag flex max-w-28 shrink items-center rounded bg-current/[0.08] font-mono text-[10px]">
          <button type="button" title={`Open ${tag}`} onClick={(e) => (e.stopPropagation(), navigate(to(tag)))} className="truncate px-1 py-px hover:underline">
            {tag}
          </button>
          {onRemove && (
            <button type="button" aria-label={`Remove tag ${tag}`} onClick={(e) => (e.stopPropagation(), onRemove(tag))} className="hidden pr-1 opacity-60 hover:opacity-100 group-hover/tag:inline">
              <X className="size-2.5" aria-hidden />
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

/** Live state at a glance: equalizer = output right now, amber = Claude waits on you, breathing blue = new output you haven't looked at, red = crashed. */
function StatusDot({ t, unread, now }: { t: TermInfo; unread: boolean; now: number }) {
  const waiting = t.claude?.state === "waiting";
  const busy = t.alive && !waiting && now - t.lastDataAt < 2000;
  const label = !t.alive ? `exited ${t.exitCode}` : waiting ? "Claude needs you" : busy ? "output now" : unread ? "new output" : "idle";
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center" title={label} aria-label={label} role="img">
      {busy ? (
        <Eq />
      ) : (
        <span
          className={cn("size-2 rounded-full transition-colors", !t.alive ? (t.exitCode ? "bg-red-500 shadow-[0_0_8px_rgb(239_68_68/0.7)]" : "bg-muted-foreground/40") : waiting ? "unread-dot bg-amber-500" : unread ? "unread-dot bg-primary" : "bg-emerald-500/80")}
          style={waiting || unread ? ({ "--c": waiting ? "#f59e0b" : "var(--primary)" } as React.CSSProperties) : undefined}
        />
      )}
    </span>
  );
}

const isClaude = (t: TermInfo) => t.alive && (!!t.claude || t.process === "claude");
const CLAUDE_STATES = {
  ready: { label: "Ready", cls: "bg-[#d97757]/12 text-[#d97757]" },
  working: { label: "Working", cls: "bg-[#d97757]/15 text-[#d97757]" },
  waiting: { label: "Needs you", cls: "bg-amber-500/15 text-amber-500" },
  done: { label: "Done", cls: "bg-emerald-500/12 text-emerald-500" },
} as const;
const MODES: Record<string, string> = { plan: "plan", bypassPermissions: "skip perms", acceptEdits: "auto-edit", auto: "auto" };

/** ✻ + where the Claude session is: Working / Needs you / Done / Ready. A `claude` typed by hand (no hooks) just reads "Claude". */
function ClaudeBadge({ t, className }: { t: TermInfo; className?: string }) {
  const s = t.claude ? CLAUDE_STATES[t.claude.state] : { label: "Claude", cls: CLAUDE_STATES.ready.cls };
  const working = t.claude?.state === "working";
  return (
    <span className={cn("flex shrink-0 items-center gap-1 rounded px-1 font-medium", s.cls, className)} title={t.claude?.note || undefined}>
      <span aria-hidden className={cn(working && "claude-spin inline-block")}>✻</span>
      <span className={cn(working && "claude-shimmer")}>{s.label}</span>
    </span>
  );
}

type ClaudeOpen = (workspaceId: string, command: string, title?: string) => void;
const LAUNCH: { label: string; hint: string; cmd: string; icon: typeof X; danger?: boolean }[] = [
  { label: "Continue last", hint: "claude -c", cmd: "claude -c", icon: History },
  { label: "Plan mode", hint: "Read-only until you approve a plan", cmd: "claude --permission-mode plan", icon: ListChecks },
  { label: "Skip permissions", hint: "Runs every tool without asking", cmd: "claude --dangerously-skip-permissions", icon: ShieldOff, danger: true },
];

/** Claude launcher for one folder: new session, continue, plan mode, skip permissions, and recent conversations to resume. */
function ClaudeMenu({ workspaceId, sessions, terms, onOpen, onShow, children, align = "start" }: { workspaceId: string; sessions: ClaudeSession[]; terms: TermInfo[]; onOpen: ClaudeOpen; onShow: (tid: string) => void; children: React.ReactNode; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const mine = sessions.filter((s) => s.workspaceId === workspaceId).slice(0, 8);
  const go = (f: () => void) => (setOpen(false), f());
  const item = "hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs outline-none";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-1.5">
        <button autoFocus className={cn(item, "py-2")} onClick={() => go(() => onOpen(workspaceId, "claude"))}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[#d97757] text-sm text-white shadow-[0_0_14px_-3px_#d97757]" aria-hidden>✻</span>
          <span className="flex-1 font-medium">New session</span>
          <Kbd className="font-mono text-[10px]">{M}⇧L</Kbd>
        </button>
        {LAUNCH.map((l) => (
          <button key={l.cmd} className={item} onClick={() => go(() => onOpen(workspaceId, l.cmd))}>
            <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden><l.icon className={cn("size-3.5", l.danger ? "text-amber-500" : "text-muted-foreground")} /></span>
            <span className="grid min-w-0 flex-1">
              <span>{l.label}</span>
              <span className="text-muted-foreground truncate text-[10.5px]">{l.hint}</span>
            </span>
          </button>
        ))}
        {mine.length > 0 && (
          <>
            <p className="text-muted-foreground mt-1.5 border-t px-2 pt-2.5 pb-1 font-mono text-[10px] font-medium tracking-[0.14em] uppercase">Resume</p>
            <div className="max-h-64 overflow-y-auto">
              {mine.map((s) => {
                const live = terms.find((t) => t.alive && t.claude?.sessionId === s.id);
                return (
                  <button key={s.id} className={item} title={s.title} onClick={() => go(() => (live ? onShow(live.id) : onOpen(workspaceId, `claude --resume ${s.id}`, s.title)))}>
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {live ? <span className="shrink-0 text-[10px] text-emerald-500">open</span> : <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">{ago(Date.now() - s.updatedAt)}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Three bouncing bars: a shell is printing right now. */
function Eq() {
  return (
    <span className="eq flex h-2.5 w-2.5 items-end justify-between" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-[2px] rounded-full bg-emerald-400" style={{ "--i": i } as React.CSSProperties} />
      ))}
    </span>
  );
}

const spring = { type: "spring", stiffness: 500, damping: 38 } as const;
const ago = (ms: number) => { const s = ms / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };

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
  [`${M}⇧L`, "New Claude session"],
  ["⌘V / drop image", "Attach a screenshot or file to Claude"],
  [`${M}E`, "Files panel for this folder (tree, viewer, git)"],
  [`${M}⇧E`, "Hide / show terminals (files only)"],
  [`${M}P`, "Go to file (files panel open)"],
  ["⌥-click / drag file", "Paste its path into the shell"],
  [`${M}⌥R`, "Restart shell (re-runs its command)"],
  [`${M}I`, "New issue from the selection (or last lines)"],
  ["@handle, ZIP-12 in name", "Tag a shell with a Zipper or ticket"],
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
  const homeState = (useLocation().state as { home?: boolean } | null)?.home;
  const home = !id && !!homeState; // h1 click: show the start screen instead of jumping to a pane
  const qc = useQueryClient();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const key = keys.res(org.id, "terminals");
  // Polled while this page is open: drives the busy / unread / crashed dots and the foreground process name.
  const { data: terms = [], isSuccess } = useQuery({ queryKey: key, queryFn: () => api.get<TermInfo[]>(`/orgs/${org.id}/terminals`), refetchInterval: 1500 });
  const { data: ports = [] } = useQuery({ queryKey: ["system", "ports"], queryFn: () => api.get<PortInfo[]>("/system/ports"), refetchInterval: 5000, enabled: terms.some((t) => t.alive) });
  const portsOf = (tid: string) => [...new Set(ports.filter((p) => p.terminalId === tid).map((p) => p.port))].sort((a, b) => a - b);
  const { data: sessions = [] } = useQuery({ queryKey: keys.res(org.id, "claude-sessions"), queryFn: () => api.get<ClaudeSession[]>(`/orgs/${org.id}/claude-sessions`), staleTime: 15_000 });
  const spawn = useApiMutation((v: { workspaceId: string; command?: string; title?: string }) => api.post<TermInfo>(`/workspaces/${v.workspaceId}/terminals`, { command: v.command, title: v.title }, true), [key, keys.res(org.id, "claude-sessions")]);
  const close = useApiMutation((termId: string) => api.del(`/terminals/${termId}`), [key]);
  const restartM = useApiMutation((termId: string) => api.post<TermInfo>(`/terminals/${termId}/restart`, {}, true), [key]);
  const rename = useApiMutation((v: { id: string; title?: string; tags?: string[] }) => api.patch(`/terminals/${v.id}`, v, true), [key]);
  const untag = (t: TermInfo, tag: string) => rename.mutate({ id: t.id, tags: t.tags.filter((x) => x !== tag) });
  // Each pane registers a getter for its selection / last lines; ⌘I turns that into a new-issue draft with the shell's folder and command.
  const textRef = useRef<Record<string, (lines: number) => string>>({});
  const { openTicketDraft } = useUI();
  const capture = (t: TermInfo | undefined) => {
    const out = t && textRef.current[t.id]?.(40);
    if (!t || !out) return void toast.error("Nothing to capture: select output in a terminal first");
    const first = out.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    const title = first.length > 90 ? `${first.slice(0, 87)}…` : first;
    const body = `\`\`\`\n${out.slice(0, 6000)}\n\`\`\`\n\nFrom terminal **${t.title}** in \`${t.cwd}\`${t.command ? `, running \`${t.command}\`` : ""}.`;
    openTicketDraft({ title, body, workspaceIds: [t.workspaceId] });
  };
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [folded, setFolded] = useState<Record<string, boolean>>({}); // ponytail: in-memory fold state; persist if it ever annoys
  const phone = usePhone();
  const [railPref, setHidden] = useState(() => store.get("zippy-term-rail") === "1");
  const hidden = railPref && !phone;
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
  const [tplFolded, setTplFolded] = useState(true);
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
    else if (!id && !home && live.length && !phone) navigate(`/terminals/${live[0]}`, { replace: true });
  }, [id, isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTerms = (opened: TermInfo[]) => qc.setQueryData<TermInfo[]>(key, (ts = []) => [...ts, ...opened.filter((t) => !ts.some((x) => x.id === t.id))]);
  const open = (workspaceId: string, split = false, command?: string, title?: string) => spawn.mutateAsync({ workspaceId, command, title }).then((t) => (addTerms([t]), show(t.id, split)));
  const openClaude: ClaudeOpen = (wid, command, title) => void open(wid, false, command, title?.slice(0, 60));
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
  /** Dropped or pasted files (screenshots, logs) live outside the folder: upload, then type their saved path. */
  const pasteFiles = async (files: File[], tid: string) => {
    for (const f of files) {
      const res = await fetch(`/api/uploads?name=${encodeURIComponent(f.name || "pasted.png")}`, { method: "POST", body: f, headers: { "x-zippy": "1" } });
      if (!res.ok) return void toast.error(`Could not attach ${f.name}`);
      pastePath(((await res.json()) as { path: string }).path, tid);
    }
  };

  // Unread: output that arrived while a terminal was off screen. The first sighting is the baseline so a shell's startup prompt doesn't count.
  const seen = useRef<Record<string, number>>({});
  const now = Date.now();
  for (const t of terms) if (live.includes(t.id) || seen.current[t.id] === undefined) seen.current[t.id] = t.lastDataAt;
  const unread = (t: TermInfo) => !live.includes(t.id) && t.lastDataAt > seen.current[t.id]! + 500;

  // A background shell that crashes, or a background Claude that needs you / finishes, gets a toast; the visible ones already show it inline.
  const wasAlive = useRef<Record<string, boolean>>({});
  const wasClaude = useRef<Record<string, string | undefined>>({});
  useEffect(() => {
    for (const t of terms) {
      const action = { label: "Show", onClick: () => show(t.id) };
      const cs = t.claude?.state;
      if (wasAlive.current[t.id] && !t.alive && t.exitCode && !live.includes(t.id)) toast.error(`${t.title} exited with code ${t.exitCode}`, { description: wsName(t.workspaceId), action });
      else if (t.id in wasClaude.current && cs !== wasClaude.current[t.id] && !live.includes(t.id)) {
        if (cs === "waiting") toast.warning(`${t.title} needs you`, { description: t.claude!.note || wsName(t.workspaceId), action });
        else if (cs === "done") toast.success(`${t.title} finished`, { description: wsName(t.workspaceId), action });
      }
      wasAlive.current[t.id] = t.alive;
      wasClaude.current[t.id] = cs;
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
  const keyState = useRef({ ordered, live, current, workspaces, fontSize, open, show, restart, font, toggleFiles, toggleShells, capture });
  keyState.current = { ordered, live, current, workspaces, fontSize, open, show, restart, font, toggleFiles, toggleShells, capture };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target as HTMLElement).closest("[role=dialog],[cmdk-root]")) return;
      const { ordered, live, current, workspaces, fontSize, open, show, restart, font, toggleFiles, toggleShells, capture } = keyState.current;
      const folder = current?.workspaceId ?? workspaces[0]?.id;
      const k = e.key.toLowerCase();
      let hit = true;
      if (k === "t" && !e.shiftKey && folder) void open(folder);
      else if (k === "l" && e.shiftKey && folder) void open(folder, false, "claude");
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
      else if (k === "i" && !e.shiftKey && !e.altKey) capture(current);
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
  const hit = (t: TermInfo, w: { name: string }) => !needle || [t.title, w.name, t.process, t.command, ...t.tags, ...portsOf(t.id).map(String)].some((s) => s.toLowerCase().includes(needle));
  const shown = home ? [] : (zoomed || phone) && current && live.includes(current.id) ? [current.id] : live;
  const n = shown.length;
  const filesWs = workspaces.find((w) => w.id === ((pickedWs && pickedWs.under === id ? pickedWs.ws : undefined) ?? current?.workspaceId ?? workspaces[0]?.id));
  const [dropping, setDropping] = useState<string | null>(null);

  const panes_ = shells && !(phone && files); // phone: files panel takes the whole screen
  const running = terms.filter((t) => t.alive).length;
  const busyN = terms.filter((t) => t.alive && now - t.lastDataAt < 2000).length;

  const row = (t: TermInfo) => {
    const idx = ordered.indexOf(t);
    const onScreen = live.includes(t.id);
    const active = t.id === id;
    const proc = t.process && !SHELLS.has(t.process) ? t.process : null;
    const tports = portsOf(t.id);
    return (
      <motion.div key={t.id} layout="position" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14, transition: { duration: 0.15 } }} transition={spring}>
        <div
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/zippy-term", t.id)}
          className={cn("group/t relative flex items-center gap-2 rounded-lg pr-1.5 pl-2.5 transition-colors", !active && "hover:bg-foreground/[0.04]")}
        >
          {active ? (
            <motion.span layoutId="term-active" transition={spring} className="ring-primary/25 absolute inset-0 rounded-lg bg-[linear-gradient(90deg,color-mix(in_oklab,var(--primary)_16%,transparent),color-mix(in_oklab,var(--primary)_3%,transparent))] ring-1" aria-hidden>
              <span className="bg-primary absolute top-2.5 bottom-2.5 -left-px w-0.5 rounded-full shadow-[0_0_10px_1px_var(--primary)]" />
            </motion.span>
          ) : (
            onScreen && <span className="bg-foreground/20 absolute top-3 bottom-3 left-0 w-0.5 rounded-full" aria-hidden />
          )}
          {editing === t.id ? (
            <input
              autoFocus
              defaultValue={t.title}
              aria-label="Terminal name"
              className="relative my-2.5 min-w-0 flex-1 rounded border-0 bg-transparent px-0 font-mono text-xs outline-none"
              onBlur={(e) => {
                const title = e.currentTarget.value.trim();
                if (title && title !== t.title) rename.mutate({ id: t.id, title });
                setEditing(null);
              }}
              onKeyDown={(e) => (e.key === "Enter" && e.currentTarget.blur(), e.key === "Escape" && ((e.currentTarget.value = t.title), e.currentTarget.blur()))}
            />
          ) : (
            <button
              className="relative flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left outline-none"
              title={`${t.command ? `$ ${t.command}\n` : ""}Double-click to rename (@handle or ZIP-12 in the name tags it) · ${M}-click to split`}
              onClick={(e) => show(t.id, e.metaKey || e.ctrlKey)}
              onDoubleClick={() => setEditing(t.id)}
            >
              <StatusDot t={t} unread={unread(t)} now={now} />
              <span className="grid min-w-0 flex-1 gap-px">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("truncate font-mono text-xs transition-colors", active || unread(t) ? "text-foreground" : "text-foreground/80", unread(t) && "font-semibold")}>{t.title}</span>
                  <TagChips t={t} className="text-muted-foreground" />
                </span>
                <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[10.5px] leading-4">
                  {!t.alive ? (
                    <span className={cn("shrink-0", t.exitCode && "text-red-500")}>exited {t.exitCode}</span>
                  ) : isClaude(t) ? (
                    <ClaudeBadge t={t} />
                  ) : proc ? (
                    <span className="text-foreground/70 shrink-0 font-mono">{proc}</span>
                  ) : (
                    <span className="truncate font-mono">{t.command ? `$ ${t.command}` : "shell"}</span>
                  )}
                  {t.lastDataAt > 0 && <span className="text-muted-foreground/60 shrink-0 tabular-nums">· {ago(now - (t.claude?.since ?? t.lastDataAt))}</span>}
                </span>
              </span>
            </button>
          )}
          {tports.length > 0 && <span className="relative flex shrink-0 items-center gap-0.5 transition-opacity group-hover/t:opacity-0"><PortChips ports={tports} /></span>}
          {idx < 9 && !tports.length && <Kbd className="relative shrink-0 font-mono text-[10px] transition-opacity group-hover/t:opacity-0">{M}{idx + 1}</Kbd>}
          <span className="absolute right-1.5 flex translate-x-1 items-center gap-0.5 opacity-0 transition-all duration-150 group-focus-within/t:translate-x-0 group-focus-within/t:opacity-100 group-hover/t:translate-x-0 group-hover/t:opacity-100">
            {!onScreen && live.length < MAX_PANES && (
              <button aria-label={`Open ${t.title} in split`} title="Open in split" onClick={() => show(t.id, true)} className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] bg-background/80 flex size-6 items-center justify-center rounded-md backdrop-blur">
                <Columns2 className="size-3.5" aria-hidden />
              </button>
            )}
            <button aria-label={`Close ${t.title}`} title="Close" onClick={() => kill(t)} className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 bg-background/80 flex size-6 items-center justify-center rounded-md backdrop-blur">
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        </div>
      </motion.div>
    );
  };

  const sectionHead = "text-muted-foreground/80 hover:text-foreground flex min-w-0 items-center gap-1 font-mono text-[10px] font-medium tracking-[0.14em] uppercase";
  const collapse = { initial: { height: 0, opacity: 0, overflow: "hidden" }, animate: { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }, exit: { height: 0, opacity: 0, overflow: "hidden" }, transition: spring } as const;

  return (
    <div className="flex min-h-0 flex-1">
      <MotionConfig reducedMotion="user">
      <motion.aside initial={false} animate={{ width: phone ? "100%" : hidden ? 48 : 272 }} transition={spring} className={cn("border-foreground/[0.07] relative flex shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_4%,transparent),transparent_40%)]", phone && id && "hidden")} aria-label="Terminals">
        <div className={cn("bg-background/70 sticky top-0 z-10 flex items-center pt-4 pb-3 backdrop-blur-md", hidden ? "justify-center px-1" : "justify-between px-4")}>
          {!hidden && (
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold tracking-tight"><button type="button" onClick={() => navigate("/terminals", { state: { home: true } })} title="Start screen">Terminals</button></h1>
              <p className="text-muted-foreground flex items-center gap-1 text-[11px] tabular-nums">
                <motion.span key={running} initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring}>{running}</motion.span> running
                <AnimatePresence>
                  {busyN > 0 && (
                    <motion.span initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-1 text-emerald-500">
                      · <Eq /> {busyN} active
                    </motion.span>
                  )}
                </AnimatePresence>
              </p>
            </div>
          )}
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
          <div className="flex flex-col items-center gap-1 px-1 pb-4">
            {ordered.map((t, i) => (
              <button key={t.id} title={t.title} aria-label={isClaude(t) ? `${t.title} (Claude${t.claude ? `, ${CLAUDE_STATES[t.claude.state].label}` : ""})` : t.title} onClick={(e) => show(t.id, e.metaKey || e.ctrlKey)} style={{ "--i": i } as React.CSSProperties} className={cn("rise relative flex size-9 items-center justify-center rounded-lg font-mono text-[10px] uppercase", t.id === id ? "text-foreground" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", t.id !== id && live.includes(t.id) && "bg-foreground/[0.04]")}>
                {t.id === id && <motion.span layoutId="term-rail-active" transition={spring} className="bg-primary/15 ring-primary/30 absolute inset-0 rounded-lg ring-1" aria-hidden />}
                {isClaude(t) ? (
                  <span className={cn("relative text-sm", t.claude?.state === "waiting" ? "text-amber-500" : "text-[#d97757]", t.claude?.state === "working" && "claude-spin")} aria-hidden>✻</span>
                ) : (
                  <span className="relative">{t.title.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "sh"}</span>
                )}
                <span className="absolute right-1 bottom-1"><StatusDot t={t} unread={unread(t)} now={now} /></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rise grid gap-4 px-3 pb-4">
            <label className="border-foreground/[0.07] bg-foreground/[0.02] focus-within:border-primary/40 focus-within:ring-primary/15 flex h-8 items-center gap-2 rounded-lg border px-2.5 transition-shadow focus-within:ring-4">
              <Search className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, folder, process, port…" aria-label="Search sessions" className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none" />
              <AnimatePresence>
                {q && (
                  <motion.button initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={spring} aria-label="Clear search" onClick={() => setQ("")} className="text-muted-foreground hover:text-foreground">
                    <X className="size-3" aria-hidden />
                  </motion.button>
                )}
              </AnimatePresence>
            </label>
            {!needle && (
              <section className="grid gap-1">
                <div className="flex items-center justify-between px-1">
                  <button onClick={() => setTplFolded((f) => !f)} aria-expanded={!tplFolded} className={sectionHead}>
                    <motion.span animate={{ rotate: tplFolded ? -90 : 0 }} transition={spring} className="flex"><ChevronDown className="size-3 shrink-0" aria-hidden /></motion.span>
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
                <AnimatePresence initial={false}>
                  {!tplFolded && (
                    <motion.div key="tpl" {...collapse} className="grid gap-0.5">
                      {templates.map((tpl) => (
                        <div key={tpl.id} className="group/p hover:bg-foreground/[0.04] flex items-center gap-1 rounded-lg pr-1 pl-1.5 transition-colors">
                          <div className="flex min-w-0 flex-1 items-center gap-2 py-1" title={tpl.steps.map((st) => (st.command || "shell") + (st.delaySec ? ` (+${st.delaySec}s)` : "")).join(" · ")}>
                            <button aria-label={`Run ${tpl.name}`} title={`Run ${tpl.name}`} onClick={() => runTemplate(tpl.id)} disabled={runTpl.isPending} className="bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-md transition-all hover:scale-110 hover:shadow-[0_0_12px_-2px_var(--primary)]">
                              <Play className="size-2.5 fill-current" aria-hidden />
                            </button>
                            <span className="truncate text-xs">{tpl.name}</span>
                            <span className="text-muted-foreground bg-foreground/[0.05] shrink-0 rounded px-1 text-[10px] tabular-nums">{tpl.steps.length}</span>
                          </div>
                          <button aria-label={`Edit ${tpl.name}`} onClick={() => setTplDialog({ open: true, edit: tpl })} className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded opacity-0 group-hover/p:opacity-100 focus-visible:opacity-100">
                            <Pencil className="size-3" aria-hidden />
                          </button>
                          <button aria-label={`Delete ${tpl.name}`} onClick={() => delTpl.mutate(tpl.id)} className="text-muted-foreground hover:text-destructive flex size-5 shrink-0 items-center justify-center rounded opacity-0 group-hover/p:opacity-100 focus-visible:opacity-100">
                            <Trash2 className="size-3" aria-hidden />
                          </button>
                        </div>
                      ))}
                      {!templates.length && (
                        <button onClick={() => (live.length ? saveLayout() : setTplDialog({ open: true, edit: null }))} disabled={!workspaces.length} className="text-muted-foreground hover:text-foreground hover:border-foreground/20 border-foreground/10 rounded-lg border border-dashed px-2.5 py-2 text-left text-xs">
                          {live.length ? "+ Save these panes to reopen in one click" : "+ Save a set of shells to reopen in one click"}
                        </button>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            )}
            {workspaces.map((w) => {
              const mine = terms.filter((t) => t.workspaceId === w.id && hit(t, w));
              if (needle && !mine.length) return null;
              const open_ = needle ? true : !folded[w.id];
              const attention = !open_ && mine.some((t) => unread(t) || (!t.alive && t.exitCode));
              return (
                <section key={w.id} className="grid gap-1">
                  <div className="group/s flex items-center justify-between px-1">
                    <button onClick={() => setFolded((f) => ({ ...f, [w.id]: !f[w.id] }))} aria-expanded={open_} className="text-foreground/85 hover:text-foreground flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-tight">
                      <motion.span animate={{ rotate: open_ ? 0 : -90 }} transition={spring} className="text-muted-foreground flex"><ChevronDown className="size-3 shrink-0" aria-hidden /></motion.span>
                      <Folder className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{w.name}</span>
                      {mine.length > 0 && <span className="bg-foreground/[0.06] text-muted-foreground rounded px-1 font-mono text-[10px] font-medium tabular-nums">{mine.length}</span>}
                      {attention && <span className="unread-dot bg-primary ml-1 size-1.5 rounded-full" style={{ "--c": "var(--primary)" } as React.CSSProperties} aria-label="new output" />}
                    </button>
                    <div className="flex">
                    <Button size="icon-xs" variant="ghost" aria-label={`New terminal in ${w.name}`} title={`New terminal in ${w.name} (${M}-click to split)`} onClick={(e) => open(w.id, e.metaKey || e.ctrlKey)} disabled={spawn.isPending} className="opacity-60 group-hover/s:opacity-100 hover:rotate-90">
                      <Plus aria-hidden />
                    </Button>
                    <ClaudeMenu workspaceId={w.id} sessions={sessions} terms={terms} onOpen={openClaude} onShow={show}>
                      <Button size="icon-xs" variant="ghost" aria-label={`Claude in ${w.name}`} title={`Claude: new, continue, resume (${M}⇧L new)`} disabled={spawn.isPending} className="opacity-60 group-hover/s:opacity-100">
                        <span className="text-[#d97757]" aria-hidden>✻</span>
                      </Button>
                    </ClaudeMenu>
                    </div>
                  </div>
                  <AnimatePresence initial={false}>
                    {open_ && (
                      <motion.div key="body" {...collapse} className="grid gap-0.5">
                        <AnimatePresence initial={false}>{mine.map(row)}</AnimatePresence>
                        {!mine.length && (
                          <button onClick={() => open(w.id)} className="text-muted-foreground hover:text-foreground hover:border-foreground/20 border-foreground/10 flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-2 text-left text-xs">
                            <Plus className="size-3" aria-hidden /> Open shell
                          </button>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              );
            })}
            {needle && !terms.some((t) => hit(t, workspaces.find((w) => w.id === t.workspaceId) ?? { name: "" })) && <p className="text-muted-foreground px-1 text-xs">No sessions match.</p>}
            {!workspaces.length && <p className="text-muted-foreground px-1 text-xs">Add a working folder first.</p>}
          </div>
        )}
      </motion.aside>
      </MotionConfig>
      {tplDialog.open && <TemplateDialog orgId={org.id} workspaces={workspaces} initial={tplDialog.edit} seed={tplDialog.seed} onClose={() => setTplDialog({ open: false, edit: null })} />}
      <Group orientation="horizontal" id="term-files" defaultLayout={filesLayout.defaultLayout} onLayoutChanged={filesLayout.onLayoutChanged} className={cn("min-h-0 min-w-0 flex-1", phone && !id && "hidden")}>
      {panes_ && (
      <Panel id="panes" minSize="30%">
      <div
        className="grid h-full min-h-0 min-w-0 gap-2 p-2 max-md:p-0"
        style={{ gridTemplateColumns: `repeat(${n <= 1 ? 1 : n <= 4 ? 2 : 3}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${n <= 2 ? 1 : 2}, minmax(0, 1fr))` }}
        onDragOver={(e) => e.dataTransfer.types.includes("text/zippy-term") && e.preventDefault()}
        onDrop={(e) => {
          const tid = e.dataTransfer.getData("text/zippy-term");
          if (tid) show(tid, true);
        }}
      >
        {live.length > 0 && (
          live.map((pid, i) => {
            const t = terms.find((x) => x.id === pid);
            if (!t) return null;
            const focused = t.id === id;
            const proc = t.process && !SHELLS.has(t.process) ? t.process : null;
            const claude = isClaude(t);
            const cs = t.claude?.state;
            return (
              <section
                key={pid}
                aria-label={t.title}
                className={cn(
                  "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-[#0f0f10] ring-1 transition-shadow duration-300 max-md:rounded-none max-md:ring-0",
                  cs === "waiting" ? "ring-amber-500/70 shadow-[0_0_0_4px_rgb(245_158_11/0.12)]" : focused && n > 1 ? "ring-primary/70" : "ring-white/[0.06]",
                  !shown.includes(pid) && "hidden",
                  n % 2 === 1 && n > 1 && i === 0 && "row-span-2",
                  dropping === pid && "ring-primary ring-2",
                )}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("text/zippy-path") && !e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (dropping !== pid) setDropping(pid);
                }}
                onDragLeave={() => dropping === pid && setDropping(null)}
                onDrop={(e) => {
                  const p = e.dataTransfer.getData("text/zippy-path");
                  const files = [...e.dataTransfer.files];
                  if (!p && !files.length) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropping(null);
                  if (p) pastePath(p, pid);
                  else void pasteFiles(files, pid);
                  navigate(`/terminals/${pid}`);
                }}
              >
                {cs === "working" && <span className="claude-line pointer-events-none absolute inset-x-0 top-0 z-10 h-px" aria-hidden />}
                <header className={cn("group/h flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 font-mono text-[11px] text-white/50", claude ? "h-9 bg-[linear-gradient(180deg,rgb(217_119_87/0.07),transparent)]" : "h-8")} onClick={() => !focused && navigate(`/terminals/${pid}`)}>
                  {phone && (
                    <button type="button" aria-label="All terminals" onClick={(e) => (e.stopPropagation(), navigate("/terminals"))} className="-ml-2 flex size-6 shrink-0 items-center justify-center rounded text-white/70">
                      <ChevronLeft className="size-4" aria-hidden />
                    </button>
                  )}
                  {claude ? <span className={cn("text-sm leading-none", cs === "waiting" ? "text-amber-400" : "text-[#d97757]", cs === "working" && "claude-spin")} aria-hidden>✻</span> : <StatusDot t={t} unread={false} now={now} />}
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
                    <span className={cn("truncate", focused ? "text-white/90" : "text-white/60", claude && "font-sans text-[12.5px] font-medium tracking-tight")} onDoubleClick={() => setEditing(`pane:${t.id}`)} title="Double-click to rename">
                      {t.title}
                    </span>
                  )}
                  <span className="truncate max-md:hidden">{wsName(t.workspaceId)}</span>
                  {t.claude?.branch && (
                    <span className="flex min-w-0 shrink items-center gap-1 truncate text-white/45 max-md:hidden" title={`Branch ${t.claude.branch}`}>
                      <GitBranch className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{t.claude.branch}</span>
                    </span>
                  )}
                  <TagChips t={t} onRemove={(tag) => untag(t, tag)} className="text-white/70 max-md:hidden" />
                  {claude ? (
                    <>
                      {t.claude && MODES[t.claude.mode] && <span className={cn("shrink-0 rounded px-1", t.claude.mode === "bypassPermissions" ? "bg-amber-500/15 text-amber-300" : "bg-white/[0.06] text-white/70")}>{MODES[t.claude.mode]}</span>}
                      <ClaudeBadge t={t} className="font-sans text-[10.5px]" />
                    </>
                  ) : (
                    proc && <span className="shrink-0 rounded bg-white/[0.06] px-1 text-white/70">{proc}</span>
                  )}
                  {!t.alive && <span className={cn("shrink-0", t.exitCode ? "text-red-400" : "")}>exit {t.exitCode}</span>}
                  <PortChips ports={portsOf(t.id)} className="text-sky-300" />
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/h:opacity-100 focus-within:opacity-100 max-md:opacity-100">
                    <PaneBtn label={`${files && focused ? "Hide" : "Show"} files for ${wsName(t.workspaceId)} (${M}E)`} onClick={() => (navigate(`/terminals/${pid}`), (!files || focused) && toggleFiles())} icon={FolderOpen} active={files && focused} />
                    <PaneBtn label={`Find (${M}F)`} onClick={() => (navigate(`/terminals/${pid}`), setFindReq((x) => x + 1))} icon={Search} />
                    {!phone && <PaneBtn label={`New issue from selection (${M}I)`} onClick={() => capture(t)} icon={FilePlus2} />}
                    <PaneBtn label={`Restart${t.command ? ` and re-run "${t.command}"` : ""} (${M}⌥R)`} onClick={() => restart(t.id)} icon={RotateCw} />
                    {!phone && live.length < MAX_PANES && <PaneBtn label={`Split (${M}D)`} onClick={() => open(t.workspaceId, true)} icon={Columns2} />}
                    {!phone && (n > 1 || zoomed) ? <PaneBtn label={`${zoomed ? "Unzoom" : "Zoom"} (${M}⇧↵)`} onClick={() => (navigate(`/terminals/${pid}`), setZoomed((z) => !z))} icon={zoomed ? Minimize2 : Maximize2} /> : null}
                    {!phone && live.length > 1 && <PaneBtn label="Remove from view (keeps running)" onClick={() => unsplit(pid)} icon={SquareX} />}
                    <PaneBtn label="Close terminal" onClick={() => kill(t)} icon={X} danger />
                  </span>
                </header>
                <AnimatePresence initial={false}>
                  {cs === "waiting" && (
                    <motion.div key="wait" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="shrink-0 overflow-hidden">
                      <p className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3.5 py-1.5 text-xs text-amber-200">
                        <span className="unread-dot size-1.5 shrink-0 rounded-full bg-amber-400" style={{ "--c": "#f59e0b" } as React.CSSProperties} aria-hidden />
                        <span className="truncate">{t.claude?.note || "Claude is waiting for your approval"}</span>
                        <span className="ml-auto shrink-0 text-amber-200/60">answer below</span>
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
                <PtyTerminal id={pid} focused={focused} fontSize={fontSize} findReq={focused ? findReq : 0} onFocus={() => !focused && navigate(`/terminals/${pid}`)} onRestart={() => restart(pid)} onFiles={(f) => void pasteFiles(f, pid)} textRef={textRef} roomy={claude} />
                {phone && focused && t.alive && (
                  <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-white/[0.06] p-1.5 font-mono text-xs text-white/80" aria-label="Terminal keys">
                    {KEYS.map(([label, data]) => (
                      // preventDefault on pointerdown keeps xterm focused so the phone keyboard stays up.
                      <button key={label} type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => void api.post(`/terminals/${t.id}/input`, { data }, true).catch(() => {})} className="h-8 min-w-9 shrink-0 rounded-md bg-white/[0.07] px-2 active:bg-white/20">
                        {label}
                      </button>
                    ))}
                    {/* Font size sets cols × rows, the main lever for fitting output on a phone. */}
                    {([["A−", -1], ["A+", 1]] as const).map(([label, d]) => (
                      <button key={label} type="button" aria-label={d < 0 ? "Smaller text" : "Larger text"} onPointerDown={(e) => e.preventDefault()} onClick={() => font(Math.min(24, Math.max(8, fontSize + d)))} className="h-8 min-w-9 shrink-0 rounded-md bg-white/[0.04] px-2 text-white/60 active:bg-white/20">
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
        {!n && <EmptyState workspaces={workspaces} templates={templates} terms={terms} sessions={sessions} onOpen={(wid, cmd) => open(wid, false, cmd)} onClaude={openClaude} onShow={(tid) => show(tid)} onRun={runTemplate} />}
      </div>
      </Panel>
      )}
      {files && filesWs && (
        <>
          {panes_ && <Separator className="bg-border hover:bg-primary focus-visible:bg-primary relative w-px outline-none transition-colors after:absolute after:inset-y-0 after:-inset-x-1" />}
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

const eyebrow = "text-muted-foreground font-mono text-[10px] font-medium tracking-[0.14em] uppercase";

function EmptyState({ workspaces, templates, terms, sessions, onOpen, onClaude, onShow, onRun }: { workspaces: Workspace[]; templates: TerminalTemplate[]; terms: TermInfo[]; sessions: ClaudeSession[]; onOpen: (wid: string, command?: string) => void; onClaude: ClaudeOpen; onShow: (tid: string) => void; onRun: (tid: string) => void }) {
  const running = terms.filter((t) => t.alive);
  const now = Date.now();
  const wsName = (wid: string) => workspaces.find((w) => w.id === wid)?.name ?? "";
  const recent = sessions.filter((s) => !terms.some((t) => t.alive && t.claude?.sessionId === s.id)).slice(0, 5);
  return (
    <div className="stagger m-auto grid w-full max-w-xl grid-cols-[minmax(0,1fr)] gap-7 p-6">
      <div className="rise flex items-center gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#e08a6b,#c4613f)] text-2xl text-white shadow-[0_8px_30px_-8px_#d97757]" aria-hidden>✻</span>
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">Start with Claude</h2>
          <p className="text-muted-foreground mt-0.5 text-[13px]">Sessions run on this machine and keep going while you're elsewhere. We'll ping you when one needs you.</p>
        </div>
      </div>
      {workspaces.length > 0 && (
        <section className="rise flex flex-col gap-2">
          <p className={eyebrow}>Start in</p>
          <div className="border-foreground/[0.07] divide-foreground/[0.06] divide-y overflow-hidden rounded-xl border">
            {workspaces.map((w) => (
              <div key={w.id} className="hover:bg-foreground/[0.02] flex items-center gap-3 px-3 py-2 transition-colors">
                <Folder className="text-muted-foreground size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{w.name}</span>
                <span className="flex">
                  <Button size="sm" onClick={() => onClaude(w.id, "claude")} title={`New Claude session in ${w.name} (${M}⇧L)`} className="rounded-r-none bg-[#d97757] text-white hover:bg-[#c96a4b]">
                    <span aria-hidden>✻</span> Claude
                  </Button>
                  <ClaudeMenu workspaceId={w.id} sessions={sessions} terms={terms} onOpen={onClaude} onShow={onShow} align="end">
                    <Button size="sm" aria-label={`More Claude options in ${w.name}`} className="rounded-l-none border-l border-white/20 bg-[#d97757] px-1.5 text-white hover:bg-[#c96a4b]">
                      <ChevronDown aria-hidden />
                    </Button>
                  </ClaudeMenu>
                </span>
                <Button size="sm" variant="outline" onClick={() => onOpen(w.id)} title={`New shell in ${w.name} (${M}T)`}>
                  <Plus aria-hidden /> Shell
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section className="rise flex flex-col gap-2">
          <p className={eyebrow}>Pick up where you left off</p>
          <div className="flex flex-col gap-0.5">
            {recent.map((s) => (
              <button key={s.id} onClick={() => onClaude(s.workspaceId, `claude --resume ${s.id}`, s.title)} title={`Resume in ${wsName(s.workspaceId)}`} className="group/r hover:bg-foreground/[0.05] flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors">
                <History className="text-muted-foreground group-hover/r:text-[#d97757] size-3.5 shrink-0 transition-colors" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">{wsName(s.workspaceId)} · {ago(now - s.updatedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {running.length > 0 && (
        <section className="rise flex flex-col gap-2">
          <p className={eyebrow}>Running · {running.length}</p>
          <div className="flex flex-col gap-0.5">
            {running.map((t) => (
              <button key={t.id} onClick={() => onShow(t.id)} className="hover:bg-foreground/[0.05] flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors">
                <StatusDot t={t} unread={false} now={now} />
                {isClaude(t) ? <span className="text-[#d97757]" aria-hidden>✻</span> : <span className="text-muted-foreground font-mono" aria-hidden>$</span>}
                <span className="truncate font-medium">{t.title}</span>
                {t.claude && <ClaudeBadge t={t} className="text-[10px]" />}
                <span className="text-muted-foreground ml-auto max-w-[45%] truncate font-mono text-[10px]">{wsName(t.workspaceId)}{t.command && !isClaude(t) ? ` · ${t.command}` : ""}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {templates.length > 0 && (
        <section className="rise flex flex-col gap-2">
          <p className={eyebrow}>Templates</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <Button key={t.id} variant="outline" size="sm" onClick={() => onRun(t.id)}>
                <Play className="text-primary fill-current" aria-hidden /> {t.name}
                <span className="text-muted-foreground text-[10px]">{t.steps.length}</span>
              </Button>
            ))}
          </div>
        </section>
      )}
      <details className="rise group border-foreground/[0.07] rounded-xl border">
        <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs"><Keyboard className="size-3.5" aria-hidden /> Keyboard shortcuts</summary>
        <div className="px-4 pb-4"><ShortcutList /></div>
      </details>
    </div>
  );
}
