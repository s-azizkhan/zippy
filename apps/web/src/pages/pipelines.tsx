import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Flag, GripVertical, Hand, Minus, Plus, Trash2, Undo2, Zap, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { pipelineInput, type Agent, type Pipeline, type PipelineInput, type StageInput } from "@zippy/shared";
import { Field, SettingRow } from "@/components/field";
import { AgentAvatar } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, keys, useAgents, useApiMutation, usePipelines } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

type Row = StageInput & { key: string };
type Form = Omit<PipelineInput, "stages"> & { stages: Row[] };

const isRef = (r: string) => /^\d+$/.test(r);
const loops = (stages: StageInput[]) => stages.some((s, i) => [s.onPass, s.onFail].some((r) => isRef(r) && Number(r) <= i));

export function PipelinesPage() {
  const org = useOrg();
  const { data: pipelines = [], isPending } = usePipelines(org.id);
  const [params, setParams] = useSearchParams();
  const sel = params.get("p");
  const open = (id: string | null) => setParams(id ? { p: id } : {});
  const current = pipelines.find((p) => p.id === sel);

  if (isPending) return <div className="mx-auto grid max-w-5xl gap-4 p-8 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}</div>;
  if (sel === "new" || current) return <PipelineEditor key={sel} pipeline={current ?? null} onOpen={open} />;
  return <PipelineList pipelines={pipelines} onOpen={open} />;
}

/* ───────────── list ───────────── */

function PipelineList({ pipelines, onOpen }: { pipelines: Pipeline[]; onOpen: (id: string) => void }) {
  const org = useOrg();
  const { data: agents = [] } = useAgents(org.id);
  const createDefault = useApiMutation(() => api.post(`/orgs/${org.id}/pipelines/default`), [keys.res(org.id, "pipelines")]);
  const agentOf = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Pipelines</h1>
            <p className="text-muted-foreground mt-1 text-sm">Chain agents into loops that build, review, fix and repeat until the ticket is done.</p>
          </div>
          <Button onClick={() => onOpen("new")}>
            <Plus aria-hidden /> New pipeline
          </Button>
        </header>

        {pipelines.length === 0 ? (
          <div className="from-primary/8 grid place-items-center gap-5 rounded-3xl border bg-gradient-to-b to-transparent px-6 py-20 text-center">
            <div className="flex items-center" aria-hidden>
              {["#5e6ad2", "#26b5ce", "#4cb782"].map((c, i) => (
                <div key={c} className="flex items-center">
                  {i > 0 && <span className="bg-border h-px w-8" />}
                  <AgentAvatar agent={{ name: ["P", "B", "R"][i]!, color: c }} className="size-10 text-sm ring-4 ring-background" />
                </div>
              ))}
            </div>
            <div>
              <h2 className="text-lg font-semibold">Build your first loop</h2>
              <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">Plan, build, review: each stage is an agent, and failures can loop back until it passes.</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => createDefault.mutate(undefined)} disabled={createDefault.isPending}>
                <Zap aria-hidden /> Use the default pipeline
              </Button>
              <Button variant="outline" onClick={() => onOpen("new")}>
                Start from scratch
              </Button>
            </div>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {pipelines.map((p, n) => (
              <motion.li key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(n, 8) * 0.04 }}>
                <button onClick={() => onOpen(p.id)} className="group bg-card hover:border-primary/40 hover:shadow-primary/5 grid h-full w-full gap-4 rounded-2xl border p-5 text-left shadow-xs transition hover:-translate-y-0.5 hover:shadow-lg">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="truncate text-[15px] font-semibold">{p.name}</h2>
                    {p.autoStart && (
                      <span className="bg-primary/10 text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                        <Zap className="size-3" aria-hidden /> Auto
                      </span>
                    )}
                  </div>
                  <div className="flex items-center" aria-hidden>
                    {p.stages.slice(0, 6).map((s, i) => (
                      <div key={s.id} className="flex items-center">
                        {i > 0 && <span className="bg-border h-px w-3" />}
                        <AgentAvatar agent={agentOf(s.agentId)} className="size-7 text-xs ring-2 ring-card" />
                      </div>
                    ))}
                    {p.stages.length > 6 && <span className="text-muted-foreground ml-1.5 text-xs">+{p.stages.length - 6}</span>}
                    {loops(p.stages) && <Undo2 className="text-[#d9822b] ml-2 size-3.5" />}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">{p.stages.map((s) => s.name).join(" → ")}</p>
                  <div className="text-muted-foreground flex items-center justify-between border-t pt-3 text-xs">
                    <span>
                      {p.stages.length} stage{p.stages.length === 1 ? "" : "s"} · up to {p.maxLoops} loop{p.maxLoops === 1 ? "" : "s"}
                    </span>
                    <ChevronRight className="size-4 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
                  </div>
                </button>
              </motion.li>
            ))}
            <li>
              <button onClick={() => onOpen("new")} className="text-muted-foreground hover:border-primary/40 hover:text-primary grid h-full min-h-40 w-full place-items-center gap-1 rounded-2xl border border-dashed p-5 text-sm transition">
                <Plus className="size-5" aria-hidden /> New pipeline
              </button>
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

/* ───────────── editor ───────────── */

const EMPTY: PipelineInput = { name: "", autoStart: false, maxLoops: 3, stages: [] };

const toInput = (p: Pipeline): PipelineInput => ({
  name: p.name,
  autoStart: p.autoStart,
  maxLoops: p.maxLoops,
  stages: p.stages.map(({ name, agentId, instruction, onPass, onFail, humanGate }) => ({ name, agentId, instruction, onPass, onFail, humanGate })),
});
const toForm = (p: PipelineInput): Form => ({ ...p, stages: p.stages.map((s) => ({ key: crypto.randomUUID(), ...s })) });
const strip = (f: Form): PipelineInput => ({ ...f, stages: f.stages.map(({ key: _, ...s }) => s) });

/** Stage refs are positions; keep them pointing at the same stage when rows move, insert or are removed. */
function remap<T extends StageInput>(stages: T[], map: (pos: number) => number | null): T[] {
  const fix = (ref: string, fallback: string) => {
    if (!isRef(ref)) return ref;
    const n = map(Number(ref));
    return n === null ? fallback : String(n);
  };
  return stages.map((s) => ({ ...s, onPass: fix(s.onPass, "next"), onFail: fix(s.onFail, "human") }));
}

const routeText = (ref: string, i: number, stages: StageInput[]) =>
  ref === "next" ? "Next stage" : ref === "done" ? "Finish" : ref === "human" ? "Ask me" : `${Number(ref) < i ? "Back to" : "Skip to"} ${Number(ref) + 1}. ${stages[Number(ref)]?.name ?? ""}`;

function PipelineEditor({ pipeline, onOpen }: { pipeline: Pipeline | null; onOpen: (id: string | null) => void }) {
  const org = useOrg();
  const { data: agents = [] } = useAgents(org.id);
  const base = pipeline ? toInput(pipeline) : EMPTY;
  const [form, setForm] = useState<Form>(() => toForm(base));
  const [selKey, setSelKey] = useState<string>();
  const [error, setError] = useState<string>();
  const inv = [keys.res(org.id, "pipelines")];
  const save = useApiMutation((v: PipelineInput) => (pipeline ? api.put<Pipeline>(`/pipelines/${pipeline.id}`, v) : api.post<Pipeline>(`/orgs/${org.id}/pipelines`, v)), inv);
  const remove = useApiMutation(() => api.del(`/pipelines/${pipeline!.id}`), inv);

  const { stages } = form;
  const dirty = JSON.stringify(strip(form)) !== JSON.stringify(base);
  const i = Math.max(0, stages.findIndex((s) => s.key === selKey));
  const cur = stages[i];

  const setStages = (next: Row[]) => setForm({ ...form, stages: next });
  const setStage = (at: number, patch: Partial<StageInput>) => setStages(stages.with(at, { ...stages[at]!, ...patch }));
  const reorder = (next: Row[]) => setStages(remap(next, (p) => next.findIndex((s) => s.key === stages[p]!.key)));
  const move = (at: number, d: -1 | 1) => {
    const j = at + d;
    const next = [...stages];
    [next[at], next[j]] = [next[j]!, next[at]!];
    setStages(remap(next, (p) => (p === at ? j : p === j ? at : p)));
  };
  const del = (at: number) => {
    setSelKey(stages[at + 1]?.key ?? stages[at - 1]?.key);
    setStages(remap(stages.toSpliced(at, 1), (p) => (p === at ? null : p > at ? p - 1 : p)));
  };
  const insert = (at: number) => {
    const agentId = stages[at - 1]?.agentId ?? agents[0]?.id;
    if (!agentId) return;
    const row: Row = { key: crypto.randomUUID(), name: `Stage ${stages.length + 1}`, agentId, instruction: "", onPass: "next", onFail: "human", humanGate: false };
    setSelKey(row.key);
    setStages(remap(stages.toSpliced(at, 0, row), (p) => (p >= at ? p + 1 : p)));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = pipelineInput.safeParse(strip(form));
    setError(r.success ? undefined : `${r.error.issues[0]!.path.join(".")}: ${r.error.issues[0]!.message}`);
    if (r.success) save.mutate(r.data, { onSuccess: (p) => onOpen(p.id) });
  }

  const back = () => (!dirty || confirm("Discard unsaved changes?")) && onOpen(null);
  const noAgents = agents.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <form onSubmit={submit} className="mx-auto max-w-5xl px-6 pt-6 pb-4" noValidate>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2" onClick={back}>
          <ArrowLeft aria-hidden /> Pipelines
        </Button>

        <header className="mt-2 mb-8 grid gap-3">
          <div className="flex items-center gap-3">
            <Input
              aria-label="Pipeline name"
              placeholder="Name your pipeline"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-auto flex-1 border-0 bg-transparent px-0 text-2xl md:text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            {pipeline && (
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => confirm(`Delete ${pipeline.name}?`) && remove.mutate(undefined, { onSuccess: () => onOpen(null) })}>
                <Trash2 aria-hidden /> Delete
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label title="Runs this pipeline when a ticket with a working folder is created or imported." className="flex cursor-pointer items-center gap-2 rounded-full border py-1 pr-1.5 pl-3">
              <Zap className="text-primary size-3.5" aria-hidden /> Start on new tickets
              <Switch checked={form.autoStart} onCheckedChange={(autoStart) => setForm({ ...form, autoStart })} />
            </label>
            <div role="group" aria-label="Max fix loops" className="flex items-center gap-1 rounded-full border py-1 pr-1 pl-3">
              <Undo2 className="size-3.5 text-[#d9822b]" aria-hidden /> Max fix loops
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Fewer loops" disabled={form.maxLoops <= 1} onClick={() => setForm({ ...form, maxLoops: form.maxLoops - 1 })}>
                <Minus aria-hidden />
              </Button>
              <span className="w-4 text-center font-semibold tabular-nums">{form.maxLoops}</span>
              <Button type="button" size="icon-xs" variant="ghost" aria-label="More loops" disabled={form.maxLoops >= 10} onClick={() => setForm({ ...form, maxLoops: form.maxLoops + 1 })}>
                <Plus aria-hidden />
              </Button>
            </div>
          </div>
        </header>

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-label="Stages">
            <Terminal icon={Zap} label={form.autoStart ? "New ticket arrives" : "Started manually"} />
            <Reorder.Group as="ol" axis="y" values={stages} onReorder={reorder}>
              {stages.map((s, n) => (
                <StageRow
                  key={s.key}
                  s={s}
                  n={n}
                  stages={stages}
                  agent={agents.find((a) => a.id === s.agentId)}
                  selected={s.key === cur?.key}
                  onSelect={() => setSelKey(s.key)}
                  onInsert={() => insert(n + 1)}
                  canInsert={!noAgents}
                />
              ))}
            </Reorder.Group>
            {stages.length === 0 && (
              <div className="text-muted-foreground mb-3 ml-11 rounded-xl border border-dashed px-4 py-8 text-center text-sm">
                {noAgents ? "Create an agent first, then add it as a stage." : "No stages yet. Each stage hands the ticket to an agent."}
              </div>
            )}
            <div className="grid grid-cols-[2rem_1fr] gap-3">
              <span />
              <Button type="button" variant="outline" className="justify-self-start rounded-full" disabled={noAgents} onClick={() => insert(stages.length)}>
                <Plus aria-hidden /> Add stage
              </Button>
            </div>
            <Terminal icon={Flag} label="Done" className="mt-3" />
          </section>

          <AnimatePresence mode="wait">
            {cur && (
              <Inspector key={cur.key} s={cur} i={i} count={stages.length} stages={stages} agents={agents} set={(p) => setStage(i, p)} move={(d) => move(i, d)} del={() => del(i)} />
            )}
          </AnimatePresence>
        </div>

        <div className="pointer-events-none sticky bottom-4 mt-8 flex h-12 justify-center">
          <AnimatePresence>
            {dirty && (
              <motion.div
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.96 }}
                className="bg-popover pointer-events-auto flex items-center gap-3 rounded-full border py-1.5 pr-1.5 pl-5 text-[13px] shadow-xl"
              >
                {error ? (
                  <span role="alert" className="text-destructive">
                    {error}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Unsaved changes</span>
                )}
                <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => (setForm(toForm(base)), setError(undefined))}>
                  Discard
                </Button>
                <Button type="submit" size="sm" className="rounded-full" disabled={save.isPending}>
                  {pipeline ? "Save pipeline" : "Create pipeline"}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </form>
    </div>
  );
}

function Terminal({ icon: Icon, label, className }: { icon: LucideIcon; label: string; className?: string }) {
  return (
    <div className={cn("relative grid grid-cols-[2rem_1fr] items-center gap-3", className)}>
      <span className="bg-muted text-muted-foreground z-10 grid size-8 place-items-center rounded-full border">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</span>
      {Icon === Zap && <span className="bg-border absolute top-8 -bottom-3 left-4 w-px" aria-hidden />}
    </div>
  );
}

function Chip({ icon: Icon, tone, children }: { icon: LucideIcon; tone?: "warn"; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", tone === "warn" ? "bg-[#f2994a]/12 text-[#d9822b]" : "bg-muted text-muted-foreground")}>
      <Icon className="size-3" aria-hidden /> {children}
    </span>
  );
}

function StageRow({ s, n, stages, agent, selected, canInsert, onSelect, onInsert }: { s: Row; n: number; stages: Row[]; agent?: Agent; selected: boolean; canInsert: boolean; onSelect: () => void; onInsert: () => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item as="li" value={s} dragListener={false} dragControls={controls} whileDrag={{ scale: 1.015, zIndex: 20 }} className="group/row relative grid grid-cols-[2rem_1fr] gap-3">
      <span className="bg-border absolute top-8 bottom-0 left-4 w-px" aria-hidden />
      <AgentAvatar agent={agent} className="z-10 size-8 text-xs ring-4 ring-background" />
      <div>
        <div className={cn("bg-card group/card relative rounded-xl border shadow-xs transition", selected ? "border-primary/60 ring-primary/10 ring-4" : "hover:border-foreground/20")}>
          <button
            type="button"
            aria-label={`Drag to reorder stage ${n + 1}`}
            onPointerDown={(e) => controls.start(e)}
            className="text-muted-foreground absolute top-1/2 -left-0.5 -translate-y-1/2 cursor-grab touch-none rounded p-0.5 opacity-0 transition group-hover/card:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
          <button type="button" onClick={onSelect} aria-pressed={selected} className="grid w-full gap-1.5 rounded-xl p-3.5 pl-5 text-left">
            <span className="flex items-baseline gap-2">
              <span className="text-[14px] font-semibold">{s.name || "Untitled"}</span>
              <span className="text-muted-foreground text-xs">{agent?.name ?? "No agent"}</span>
            </span>
            <span className="text-muted-foreground line-clamp-2 text-xs">{s.instruction || "Uses the agent's role prompt"}</span>
            <span className="flex flex-wrap gap-1.5 pt-0.5">
              {s.humanGate && <Chip icon={Hand}>Waits for approval</Chip>}
              {s.onPass !== "next" && <Chip icon={ArrowDown}>{routeText(s.onPass, n, stages)}</Chip>}
              <Chip icon={Undo2} tone={isRef(s.onFail) ? "warn" : undefined}>
                Fail: {routeText(s.onFail, n, stages)}
              </Chip>
            </span>
          </button>
        </div>
        <div className="flex h-7 items-center">
          {canInsert && (
            <button type="button" onClick={onInsert} className="text-muted-foreground hover:text-primary flex items-center gap-1 rounded-full px-2 text-xs opacity-0 transition group-hover/row:opacity-100 focus-visible:opacity-100">
              <Plus className="size-3" aria-hidden /> Insert stage
            </button>
          )}
        </div>
      </div>
    </Reorder.Item>
  );
}

function Inspector({ s, i, count, stages, agents, set, move, del }: { s: Row; i: number; count: number; stages: Row[]; agents: Agent[]; set: (p: Partial<StageInput>) => void; move: (d: -1 | 1) => void; del: () => void }) {
  return (
    <motion.aside initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} aria-label={`Stage ${i + 1} settings`} className="bg-card grid gap-4 rounded-2xl border p-5 shadow-xs lg:sticky lg:top-6">
      <div className="flex items-center gap-1">
        <h3 className="mr-auto text-[13px] font-semibold">Stage {i + 1}</h3>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(-1)}>
          <ArrowUp aria-hidden />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === count - 1} onClick={() => move(1)}>
          <ArrowDown aria-hidden />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove stage" onClick={del}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      <Field label="Name">{(p) => <Input {...p} value={s.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
      <Field label="Agent">{(p) => <AgentSelect id={p.id} agents={agents} value={s.agentId} onChange={(agentId) => set({ agentId })} />}</Field>
      <Field label="Instruction" hint="Optional. The agent's role prompt still applies.">
        {(p) => <Textarea {...p} placeholder="What should this stage do?" value={s.instruction} onChange={(e) => set({ instruction: e.target.value })} className="min-h-24 text-[13px]" />}
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <RouteSelect label="On pass" value={s.onPass} onChange={(onPass) => set({ onPass })} fixed={[["next", "Next stage"], ["done", "Finish"]]} stages={stages} self={i} />
        <RouteSelect label="On fail" value={s.onFail} onChange={(onFail) => set({ onFail })} fixed={[["human", "Ask me"]]} stages={stages} self={i} />
      </div>
      <SettingRow label="Approval gate" hint="Wait for me before moving on.">
        {(p) => <Switch {...p} checked={s.humanGate} onCheckedChange={(humanGate) => set({ humanGate })} />}
      </SettingRow>
    </motion.aside>
  );
}

function AgentSelect({ id, agents, value, onChange }: { id?: string; agents: Agent[]; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label="Agent" className="w-full min-w-0 *:data-[slot=select-value]:min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            <AgentAvatar agent={a} className="size-4" /> {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RouteSelect(props: { label: string; value: string; onChange: (v: string) => void; fixed: [string, string][]; stages: StageInput[]; self: number }) {
  return (
    <div className="grid min-w-0 gap-1.5 text-[13px]">
      <span className="font-medium">{props.label}</span>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger size="sm" aria-label={props.label} className="w-full min-w-0 *:data-[slot=select-value]:min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.fixed.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
          {props.stages.map((s, pos) =>
            pos === props.self ? null : (
              <SelectItem key={pos} value={String(pos)}>
                {pos < props.self ? "Back to" : "Skip to"} {pos + 1}. {s.name}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
