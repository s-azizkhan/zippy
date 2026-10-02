import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { pipelineInput, type Agent, type Pipeline, type PipelineInput, type StageInput } from "@zippy/shared";
import { Field } from "@/components/field";
import { AgentAvatar } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, keys, useAgents, useApiMutation, usePipelines } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

export function PipelinesPage() {
  const org = useOrg();
  const { data: pipelines = [] } = usePipelines(org.id);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const current = selected === "new" ? null : (pipelines.find((p) => p.id === selected) ?? pipelines[0]);

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-64 shrink-0 flex-col border-r" aria-label="Pipelines">
        <header className="flex h-12 items-center justify-between border-b px-4">
          <h1 className="text-[13px] font-semibold">Pipelines</h1>
          <Button size="icon-sm" variant="ghost" aria-label="New pipeline" onClick={() => setSelected("new")}>
            <Plus aria-hidden />
          </Button>
        </header>
        <ul className="overflow-y-auto p-2">
          {pipelines.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelected(p.id)}
                aria-current={(current?.id === p.id && selected !== "new") || undefined}
                className={cn("hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", current?.id === p.id && selected !== "new" && "bg-accent")}
              >
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-muted-foreground text-xs">{p.stages.length} stages</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex-1 overflow-y-auto">
        <PipelineEditor key={selected === "new" ? "new" : current?.id} pipeline={selected === "new" ? null : current} onSaved={setSelected} />
      </div>
    </div>
  );
}

const toInput = (p: Pipeline): PipelineInput => ({
  name: p.name,
  autoStart: p.autoStart,
  maxLoops: p.maxLoops,
  stages: p.stages.map(({ name, agentId, instruction, onPass, onFail, humanGate }) => ({ name, agentId, instruction, onPass, onFail, humanGate })),
});

/** Stage refs are positions; keep them pointing at the same stage when rows move or are removed. */
function remap(stages: StageInput[], map: (pos: number) => number | null): StageInput[] {
  const fix = (ref: string, fallback: string) => {
    if (!/^\d+$/.test(ref)) return ref;
    const n = map(Number(ref));
    return n === null ? fallback : String(n);
  };
  return stages.map((s) => ({ ...s, onPass: fix(s.onPass, "next"), onFail: fix(s.onFail, "human") }));
}

function PipelineEditor({ pipeline, onSaved }: { pipeline: Pipeline | null | undefined; onSaved: (id: string | null) => void }) {
  const org = useOrg();
  const { data: agents = [] } = useAgents(org.id);
  const [form, setForm] = useState<PipelineInput>(pipeline ? toInput(pipeline) : { name: "", autoStart: false, maxLoops: 3, stages: [] });
  const [error, setError] = useState<string>();
  const inv = [keys.res(org.id, "pipelines")];
  const save = useApiMutation((v: PipelineInput) => (pipeline ? api.put<Pipeline>(`/pipelines/${pipeline.id}`, v) : api.post<Pipeline>(`/orgs/${org.id}/pipelines`, v)), inv);
  const remove = useApiMutation(() => api.del(`/pipelines/${pipeline!.id}`), inv);
  const createDefault = useApiMutation(() => api.post(`/orgs/${org.id}/pipelines/default`), inv);

  const setStage = (i: number, patch: Partial<StageInput>) => setForm({ ...form, stages: form.stages.with(i, { ...form.stages[i]!, ...patch }) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    const stages = [...form.stages];
    [stages[i], stages[j]] = [stages[j]!, stages[i]!];
    setForm({ ...form, stages: remap(stages, (p) => (p === i ? j : p === j ? i : p)) });
  };
  const del = (i: number) => setForm({ ...form, stages: remap(form.stages.toSpliced(i, 1), (p) => (p === i ? null : p > i ? p - 1 : p)) });
  const add = () =>
    agents[0] && setForm({ ...form, stages: [...form.stages, { name: `Stage ${form.stages.length + 1}`, agentId: agents[0].id, instruction: "", onPass: "next", onFail: "human", humanGate: false }] });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = pipelineInput.safeParse(form);
    setError(r.success ? undefined : `${r.error.issues[0]!.path.join(".")}: ${r.error.issues[0]!.message}`);
    if (r.success) save.mutate(r.data, { onSuccess: (p) => onSaved(p.id) });
  }

  if (pipeline === undefined) {
    return (
      <div className="text-muted-foreground grid place-items-center gap-3 p-16 text-sm">
        No pipelines yet.
        <Button onClick={() => createDefault.mutate(undefined)}>Create the default pipeline</Button>
      </div>
    );
  }

  const stageLabel = (pos: number) => `${pos + 1}. ${form.stages[pos]?.name ?? ""}`;

  return (
    <form onSubmit={submit} className="mx-auto grid max-w-3xl gap-5 px-6 py-8" noValidate>
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">{pipeline ? pipeline.name : "New pipeline"}</h2>
        {pipeline && (
          <Button type="button" variant="ghost" size="sm" className="text-destructive ml-auto" onClick={() => confirm(`Delete ${pipeline.name}?`) && remove.mutate(undefined, { onSuccess: () => onSaved(null) })}>
            <Trash2 aria-hidden /> Delete
          </Button>
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-4">
        <Field label="Name">{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Max fix loops">
          {(p) => <Input {...p} type="number" min={1} max={10} value={form.maxLoops} onChange={(e) => setForm({ ...form, maxLoops: Number(e.target.value) })} className="w-24" />}
        </Field>
      </div>
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <p id="auto-start" className="text-[13px] font-medium">
            Start on new tickets
          </p>
          <p className="text-muted-foreground text-xs">Runs this pipeline when a ticket with a working folder is created or imported.</p>
        </div>
        <Switch aria-labelledby="auto-start" checked={form.autoStart} onCheckedChange={(autoStart) => setForm({ ...form, autoStart })} />
      </div>

      <section aria-labelledby="stages-h" className="grid gap-3">
        <h3 id="stages-h" className="text-[13px] font-semibold">
          Stages
        </h3>
        <ol className="grid gap-3">
          {form.stages.map((s, i) => (
            <li key={i} className="grid gap-3 rounded-lg border p-3" aria-label={`Stage ${i + 1}: ${s.name}`}>
              <div className="flex items-center gap-2">
                <span className="bg-muted flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums" aria-hidden>
                  {i + 1}
                </span>
                <Input aria-label="Stage name" value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} className="h-8 max-w-48" />
                <AgentSelect agents={agents} value={s.agentId} onChange={(agentId) => setStage(i, { agentId })} />
                <div className="ml-auto flex">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === form.stages.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove stage" onClick={() => del(i)}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <RouteSelect label="On pass" value={s.onPass} onChange={(onPass) => setStage(i, { onPass })} fixed={[["next", "Next stage"], ["done", "Done"]]} stages={form.stages.length} stageLabel={stageLabel} self={i} />
                <RouteSelect label="On fail" value={s.onFail} onChange={(onFail) => setStage(i, { onFail })} fixed={[["human", "Ask me"]]} stages={form.stages.length} stageLabel={stageLabel} self={i} />
              </div>
              <Textarea aria-label="Stage instruction" placeholder="Instruction for this stage (optional; the agent's role prompt still applies)" value={s.instruction} onChange={(e) => setStage(i, { instruction: e.target.value })} className="min-h-16 text-[13px]" />
              <label className="text-muted-foreground flex items-center gap-2 text-xs">
                <Switch checked={s.humanGate} onCheckedChange={(humanGate) => setStage(i, { humanGate })} /> Wait for my approval before moving on
              </label>
            </li>
          ))}
        </ol>
        <Button type="button" variant="outline" className="justify-self-start" onClick={add}>
          <Plus aria-hidden /> Add stage
        </Button>
      </section>

      {error && (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {pipeline ? "Save pipeline" : "Create pipeline"}
        </Button>
      </div>
    </form>
  );
}

function AgentSelect({ agents, value, onChange }: { agents: Agent[]; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label="Agent" className="w-auto">
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

function RouteSelect(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  fixed: [string, string][];
  stages: number;
  stageLabel: (pos: number) => string;
  self: number;
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger size="sm" aria-label={props.label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.fixed.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
          {Array.from({ length: props.stages }, (_, pos) =>
            pos === props.self ? null : (
              <SelectItem key={pos} value={String(pos)}>
                Go to {props.stageLabel(pos)}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </label>
  );
}
