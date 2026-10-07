import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, GripVertical, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { TerminalTemplate, TerminalTemplateInput, Workspace } from "@zippy/shared";
import { Field } from "@/components/field";
import { OptionSelect } from "@/components/property-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, keys, useApiMutation, useTerminalTemplates, useTerminals, useWorkspaces, type TermInfo } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

/** Interactive shell attached to a server-side PTY. Output streams over SSE, keystrokes go back over POST. */
function PtyTerminal({ id, onExit }: { id: string; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const t = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 10_000,
      theme: { background: "#0f0f10", foreground: "#c9cacd" },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    fit.fit();
    t.focus();

    // ponytail: one POST per xterm data event; keystrokes on localhost are cheap enough.
    // Replaying scrollback re-triggers old terminal queries (colour, DA, cursor position); their replies must not reach the shell as typed text.
    let replaying = false;
    t.onData((data) => replaying || void api.post(`/terminals/${id}/input`, { data }, true).catch(() => {}));

    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
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
      t.write(`\r\n\x1b[2m[process exited with code ${(e as MessageEvent).data}]\x1b[0m\r\n`);
      es.close();
      onExit();
    });

    return () => {
      es.close();
      ro.disconnect();
      clearTimeout(resizeTimer);
      t.dispose();
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className="h-full min-h-0 w-full overflow-hidden rounded-xl bg-[#0f0f10] p-2" />;
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
function TemplateDialog({ orgId, workspaces, initial, onClose }: { orgId: string; workspaces: Workspace[]; initial: TerminalTemplate | null; onClose: () => void }) {
  const key = keys.res(orgId, "terminal-templates");
  const [name, setName] = useState(initial?.name ?? "");
  const [steps, setSteps] = useState<KeyedStep[]>(() => (initial ? initial.steps.map((st) => ({ ...blankStep(st.workspaceId), ...st, key: ++stepSeq })) : [blankStep(workspaces[0]?.id ?? "")]));
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
  const { data: terms = [] } = useTerminals(org.id);
  const key = keys.res(org.id, "terminals");
  const spawn = useApiMutation((workspaceId: string) => api.post<TermInfo>(`/workspaces/${workspaceId}/terminals`, {}, true), [key]);
  const close = useApiMutation((termId: string) => api.del(`/terminals/${termId}`), [key]);
  const rename = useApiMutation((v: { id: string; title: string }) => api.patch(`/terminals/${v.id}`, { title: v.title }, true), [key]);
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [folded, setFolded] = useState<Record<string, boolean>>({}); // ponytail: in-memory fold state; persist if it ever annoys
  const [hidden, setHidden] = useState(() => localStorage.getItem("zippy-term-rail") === "1");
  const toggleRail = () => setHidden((h) => (localStorage.setItem("zippy-term-rail", h ? "0" : "1"), !h));
  const { data: templates = [] } = useTerminalTemplates(org.id);
  const tkey = keys.res(org.id, "terminal-templates");
  const [tplDialog, setTplDialog] = useState<{ open: boolean; edit: TerminalTemplate | null }>({ open: false, edit: null });
  const [tplFolded, setTplFolded] = useState(false);
  const runTpl = useApiMutation((tplId: string) => api.post<TermInfo[]>(`/terminal-templates/${tplId}/run`, {}, true), [key]);
  const delTpl = useApiMutation((tplId: string) => api.del(`/terminal-templates/${tplId}`), [tkey]);
  const current = terms.find((t) => t.id === id);
  const needle = q.trim().toLowerCase();
  const hit = (t: TermInfo, w: { name: string }) => !needle || t.title.toLowerCase().includes(needle) || w.name.toLowerCase().includes(needle);

  const open = (workspaceId: string) => spawn.mutateAsync(workspaceId).then((t) => navigate(`/terminals/${t.id}`));
  const kill = (t: TermInfo) => close.mutateAsync(t.id).then(() => t.id === id && navigate("/terminals"));

  return (
    <div className="flex min-h-0 flex-1">
      <aside className={cn("border-foreground/[0.07] flex shrink-0 flex-col gap-3 overflow-y-auto border-r py-4 transition-[width] duration-150", hidden ? "w-11 items-center px-1" : "w-60 px-3")} aria-label="Terminals">
        <div className={cn("flex items-center", hidden ? "justify-center" : "justify-between px-1")}>
          {!hidden && <h1 className="text-[15px] font-semibold tracking-tight">Terminals</h1>}
          <Button size="icon-xs" variant="ghost" aria-label={hidden ? "Show terminal list" : "Hide terminal list"} onClick={toggleRail}>
            {hidden ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
          </Button>
        </div>
        {hidden ? (
          terms.map((t) => (
            <button key={t.id} title={t.title} aria-label={t.title} onClick={() => navigate(`/terminals/${t.id}`)} className={cn("hover:bg-foreground/[0.06] flex size-8 items-center justify-center rounded-lg", t.id === id && "bg-foreground/[0.08]")}>
              <span className={cn("size-2 rounded-full", t.alive ? "bg-emerald-500" : "bg-muted-foreground/40")} aria-hidden />
            </button>
          ))
        ) : (
          <>
            <label className="border-foreground/[0.07] bg-background/40 focus-within:border-primary/40 flex h-8 items-center gap-2 rounded-lg border px-2">
              <Search className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions…" aria-label="Search sessions" className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none" />
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
                  <Button size="icon-xs" variant="ghost" aria-label="New template" onClick={() => setTplDialog({ open: true, edit: null })} disabled={!workspaces.length}>
                    <Plus aria-hidden />
                  </Button>
                </div>
                {!tplFolded &&
                  templates.map((tpl) => (
                    <div key={tpl.id} className="group/p hover:bg-foreground/[0.05] flex items-center gap-1 rounded-lg pr-1 pl-2 text-[13px]">
                      <button className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left" title={tpl.steps.map((st) => (st.command || "shell") + (st.delaySec ? ` (+${st.delaySec}s)` : "")).join(" · ")} onClick={() => runTpl.mutateAsync(tpl.id).then((t) => t[0] && navigate(`/terminals/${t[0].id}`))} disabled={runTpl.isPending}>
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
                  <button onClick={() => setTplDialog({ open: true, edit: null })} disabled={!workspaces.length} className="text-muted-foreground hover:text-foreground px-2 py-1 text-left text-xs">
                    + Save a set of shells to reopen in one click
                  </button>
                )}
              </section>
            )}
            {workspaces.map((w) => {
              const mine = terms.filter((t) => t.workspaceId === w.id && hit(t, w));
              if (needle && !mine.length) return null;
              const open_ = needle ? true : !folded[w.id];
              return (
                <section key={w.id} className="grid gap-0.5">
                  <div className="flex items-center justify-between px-1">
                    <button onClick={() => setFolded((f) => ({ ...f, [w.id]: !f[w.id] }))} aria-expanded={open_} className="text-muted-foreground/80 hover:text-foreground flex min-w-0 items-center gap-1 font-mono text-[10px] font-medium tracking-[0.14em] uppercase">
                      <ChevronDown className={cn("size-3 shrink-0 transition-transform", !open_ && "-rotate-90")} aria-hidden />
                      <span className="truncate">{w.name}</span>
                      {!open_ && mine.length > 0 && <span className="text-muted-foreground/60 ml-1 normal-case tracking-normal">{mine.length}</span>}
                    </button>
                    <Button size="icon-xs" variant="ghost" aria-label={`New terminal in ${w.name}`} onClick={() => open(w.id)} disabled={spawn.isPending}>
                      <Plus aria-hidden />
                    </Button>
                  </div>
                  {open_ &&
                    mine.map((t) => (
                      <div key={t.id} className={cn("group/t hover:bg-foreground/[0.05] flex items-center gap-2 rounded-lg pr-1 pl-2 text-[13px]", t.id === id && "bg-foreground/[0.07]")}>
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
                          <button className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left" title="Double-click to rename" onClick={() => navigate(`/terminals/${t.id}`)} onDoubleClick={() => setEditing(t.id)}>
                            <span className={cn("size-1.5 shrink-0 rounded-full", t.alive ? "bg-emerald-500" : "bg-muted-foreground/40")} aria-hidden />
                            <span className="truncate font-mono text-xs">{t.title}</span>
                            {!t.alive && <span className="text-muted-foreground text-[10px]">exit {t.exitCode}</span>}
                          </button>
                        )}
                        <button aria-label={`Close ${t.title}`} onClick={() => kill(t)} className="text-muted-foreground hover:text-destructive flex size-5 shrink-0 items-center justify-center rounded opacity-0 group-hover/t:opacity-100 focus-visible:opacity-100">
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </div>
                    ))}
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
      {tplDialog.open && <TemplateDialog orgId={org.id} workspaces={workspaces} initial={tplDialog.edit} onClose={() => setTplDialog({ open: false, edit: null })} />}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {current ? (
          <>
            <div className="text-muted-foreground mb-2 flex items-center gap-2 px-1 font-mono text-[11px]">
              <span className="text-foreground">{current.title}</span>
              <span>·</span>
              <span className="truncate">{workspaces.find((w) => w.id === current.workspaceId)?.name}</span>
              <span>·</span>
              <span>pid {current.pid}</span>
            </div>
            <PtyTerminal key={current.id} id={current.id} onExit={() => qc.invalidateQueries({ queryKey: key })} />
          </>
        ) : (
          <p className="text-muted-foreground m-auto rounded-xl border border-dashed px-6 py-10 text-center text-[13px]">
            Pick a terminal, or press + next to a folder to open a shell there.
          </p>
        )}
      </div>
    </div>
  );
}
