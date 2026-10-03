import { MdEditor } from "@/components/md-editor";
import { Trash2 } from "lucide-react";
import { PlayIcon as Play } from "@/components/ui/play";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { useState } from "react";
import { useNavigate } from "react-router";
import { routineInput, type Routine, type RoutineInput, type Ticket } from "@zippy/shared";
import { Field, fieldErrors } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, keys, useAgents, useApiMutation, usePipelines, useRoutines, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago } from "@/lib/utils";

const BLANK: RoutineInput = { name: "", title: "", body: "", workspaceIds: [], assigneeAgentId: null, pipelineId: null, everyHours: 24, enabled: true };
const selectCls = "border-input bg-background h-8 w-full rounded-md border px-2 text-[13px]";

export function RoutinesPage() {
  const org = useOrg();
  const { data = [] } = useRoutines(org.id);
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">Routines</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-3xl gap-4 px-6 py-8">
          <p className="text-muted-foreground text-[13px]">Recurring work: every N hours Zippy creates a ticket from the template and starts its pipeline or Zipper. Dependency bumps, Sentry triage, weekly audits.</p>
          {data.map((r) => (
            <RoutineForm key={r.id} routine={r} />
          ))}
          {adding ? (
            <RoutineForm onDone={() => setAdding(false)} />
          ) : (
            <Button variant="outline" className="justify-self-start" onClick={() => setAdding(true)}>
              <Plus aria-hidden /> Add routine
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function RoutineForm({ routine, onDone }: { routine?: Routine; onDone?: () => void }) {
  const org = useOrg();
  const navigate = useNavigate();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { data: agents = [] } = useAgents(org.id);
  const { data: pipelines = [] } = usePipelines(org.id);
  const [form, setForm] = useState<RoutineInput>(routine ?? BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inv = [keys.res(org.id, "routines")];
  const save = useApiMutation((v: RoutineInput) => (routine ? api.patch(`/routines/${routine.id}`, v) : api.post(`/orgs/${org.id}/routines`, v)), inv);
  const remove = useApiMutation(() => api.del(`/routines/${routine!.id}`), inv);
  const run = useApiMutation(() => api.post<Ticket>(`/routines/${routine!.id}/run`), [...inv, keys.res(org.id, "tickets")]);
  const set = <K extends keyof RoutineInput>(k: K, v: RoutineInput[K]) => setForm({ ...form, [k]: v });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = routineInput.safeParse(form);
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(r.data, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border p-4" noValidate aria-label={routine ? `Routine ${routine.name}` : "New routine"}>
      <div className="grid grid-cols-[1fr_8rem] gap-4">
        <Field label="Name" error={errors.name}>{(p) => <Input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Weekly dependency bump" />}</Field>
        <Field label="Every (hours)" error={errors.everyHours}>
          {(p) => <Input {...p} type="number" min={1} value={form.everyHours} onChange={(e) => set("everyHours", Number(e.target.value))} />}
        </Field>
      </div>
      <Field label="Ticket title" hint="The run date is appended." error={errors.title}>{(p) => <Input {...p} value={form.title} onChange={(e) => set("title", e.target.value)} />}</Field>
      <Field label="Ticket description">{(p) => <MdEditor id={p.id} value={form.body} onChange={(v) => set("body", v)} className="min-h-20" />}</Field>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-[13px] font-medium">Folders</legend>
        <div className="flex flex-wrap gap-3">
          {workspaces.map((w) => (
            <label key={w.id} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={form.workspaceIds.includes(w.id)}
                onChange={(e) => set("workspaceIds", e.target.checked ? [...form.workspaceIds, w.id] : form.workspaceIds.filter((x) => x !== w.id))}
              />
              {w.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Pipeline" hint="Needs at least one folder.">
          {(p) => (
            <select {...p} value={form.pipelineId ?? ""} onChange={(e) => set("pipelineId", e.target.value || null)} className={selectCls}>
              <option value="">None</option>
              {pipelines.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Or Zipper" hint="Used when no pipeline is set.">
          {(p) => (
            <select {...p} value={form.assigneeAgentId ?? ""} onChange={(e) => set("assigneeAgentId", e.target.value || null)} className={selectCls}>
              <option value="">Nobody (ticket only)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (@{a.handle})
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {routine ? "Save" : "Add routine"}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        {routine && (
          <Button type="button" size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate(undefined, { onSuccess: (t) => navigate(`/t/${t.identifier}`) })}>
            <Play aria-hidden /> Run now
          </Button>
        )}
        {routine && <span className="text-muted-foreground text-xs">{routine.lastRunAt ? `Last run ${ago(routine.lastRunAt)}` : "Not run yet"}</span>}
        <label className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
          Enabled <Switch checked={form.enabled} onCheckedChange={(enabled) => set("enabled", enabled)} />
        </label>
        {routine && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => confirm(`Remove ${routine.name}?`) && remove.mutate(undefined)}>
            <Trash2 aria-hidden /> Remove
          </Button>
        )}
      </div>
    </form>
  );
}
