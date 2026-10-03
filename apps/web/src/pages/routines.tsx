import { MdEditor } from "@/components/md-editor";
import { ArrowLeft, Check, ChevronRight, Clock, FolderGit2, Pencil, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { PlayIcon as Play } from "@/components/ui/play";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { RefreshCWIcon as Refresh } from "@/components/ui/refresh-cw";
import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router";
import { nextRunAt, routineInput, type Agent, type Pipeline, type Routine, type RoutineInput, type Ticket, type Workspace } from "@zippy/shared";
import { ErrorPage } from "@/components/error-page";
import { Field, fieldErrors } from "@/components/field";
import { OptionSelect } from "@/components/property-menu";
import { AgentAvatar, StatusIcon, STATUS } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, keys, useAgents, useApiMutation, usePipelines, useRoutines, useTickets, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn } from "@/lib/utils";
import { ConfirmDialog } from "@/pages/settings";

const BLANK: RoutineInput = { name: "", title: "", body: "", workspaceIds: [], assigneeAgentId: null, pipelineId: null, everyHours: 24, runAt: null, enabled: true };
const PRESETS = [
  { label: "Hourly", hours: 1 },
  { label: "Daily", hours: 24 },
  { label: "Weekly", hours: 168 },
  { label: "Monthly", hours: 720 },
];

const toInput = ({ name, title, body, workspaceIds, assigneeAgentId, pipelineId, everyHours, runAt, enabled }: Routine): RoutineInput => ({ name, title, body, workspaceIds, assigneeAgentId, pipelineId, everyHours, runAt, enabled });

function cadence({ everyHours: h, runAt }: Pick<RoutineInput, "everyHours" | "runAt">) {
  const every = h % 168 === 0 ? (h === 168 ? "Weekly" : `Every ${h / 168} weeks`) : h % 24 === 0 ? (h === 24 ? "Daily" : `Every ${h / 24} days`) : h === 1 ? "Hourly" : `Every ${h} hours`;
  return runAt ? `${every} at ${runAt}` : every;
}
const when = (d: Date) => d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const nextText = (r: Routine) => (r.enabled ? `${when(nextRunAt(r))} · ${ago(nextRunAt(r).toISOString())}` : "Paused");

/** Pipeline wins over Zipper; neither = ticket only. */
function useTarget(r: Pick<RoutineInput, "pipelineId" | "assigneeAgentId">) {
  const org = useOrg();
  const { data: pipelines = [] } = usePipelines(org.id);
  const { data: agents = [] } = useAgents(org.id);
  const pipeline = pipelines.find((p) => p.id === r.pipelineId);
  const agent = agents.find((a) => a.id === r.assigneeAgentId);
  return { pipeline, agent, pipelines, agents };
}

function TargetChip({ r }: { r: Pick<RoutineInput, "pipelineId" | "assigneeAgentId"> }) {
  const { pipeline, agent, agents } = useTarget(r);
  if (pipeline)
    return (
      <span className="flex items-center gap-2">
        <span className="flex -space-x-1.5">
          {pipeline.stages.slice(0, 4).map((s) => (
            <AgentAvatar key={s.id} agent={agents.find((a) => a.id === s.agentId)} className="ring-card size-5 ring-2" />
          ))}
        </span>
        <span className="truncate">{pipeline.name}</span>
      </span>
    );
  if (agent)
    return (
      <span className="flex items-center gap-2">
        <AgentAvatar agent={agent} className="size-5" />
        <span className="truncate">{agent.name}</span>
      </span>
    );
  return <span className="text-muted-foreground">Ticket only</span>;
}

function useRoutineActions(r: Routine) {
  const org = useOrg();
  const navigate = useNavigate();
  const inv = [keys.res(org.id, "routines")];
  const toggle = useApiMutation((enabled: boolean) => api.patch(`/routines/${r.id}`, { ...toInput(r), enabled }), inv);
  const run = useApiMutation(() => api.post<Ticket>(`/routines/${r.id}/run`), [...inv, keys.res(org.id, "tickets")]);
  const remove = useApiMutation(() => api.del(`/routines/${r.id}`), inv);
  return { toggle, remove, run: () => run.mutate(undefined, { onSuccess: (t) => navigate(`/t/${t.identifier}`) }), running: run.isPending };
}

const Page = ({ children }: { children: ReactNode }) => (
  <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-5xl px-6 py-10">{children}</div>
  </div>
);

const Back = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1.5 text-[13px] transition">
    <ArrowLeft className="size-3.5" aria-hidden /> {children}
  </Link>
);

const Status = ({ on }: { on: boolean }) => (
  <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", on ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-muted text-muted-foreground")}>
    <span className={cn("size-1.5 rounded-full", on ? "bg-green-500" : "bg-muted-foreground/50")} /> {on ? "Active" : "Paused"}
  </span>
);

const Tile = ({ className }: { className?: string }) => (
  <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl bg-[#f2c94c]/15 text-[#c9a227]", className)} aria-hidden>
    <Refresh size={18} />
  </span>
);

/* ───────────── list ───────────── */

export function RoutinesPage() {
  const org = useOrg();
  const { data = [], isPending } = useRoutines(org.id);
  const active = data.filter((r) => r.enabled);
  const paused = data.filter((r) => !r.enabled);
  return (
    <Page>
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">Recurring work on autopilot. Zippy opens a ticket from a template on schedule and hands it to a pipeline or Zipper.</p>
        </div>
        <Button asChild>
          <Link to="/routines/new">
            <Plus aria-hidden /> New routine
          </Link>
        </Button>
      </header>

      {isPending ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : data.length === 0 ? (
        <div className="from-primary/8 grid place-items-center gap-5 rounded-3xl border bg-gradient-to-b to-transparent px-6 py-20 text-center">
          <Tile className="size-12 rounded-2xl" />
          <div>
            <h2 className="text-lg font-semibold">Automate the boring stuff</h2>
            <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">Dependency bumps, Sentry triage, weekly audits. Set a schedule once and tickets show up on their own.</p>
          </div>
          <Button asChild>
            <Link to="/routines/new">
              <Plus aria-hidden /> Create your first routine
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-8">
          <Group title="Active" routines={active} />
          <Group title="Paused" routines={paused} />
        </div>
      )}
    </Page>
  );
}

function Group({ title, routines }: { title: string; routines: Routine[] }) {
  if (!routines.length) return null;
  return (
    <section>
      <h2 className="text-muted-foreground mb-2 px-1 text-xs font-medium tracking-wide uppercase">
        {title} <span className="tabular-nums">· {routines.length}</span>
      </h2>
      <ul className="bg-card divide-y overflow-hidden rounded-2xl border shadow-xs">
        {routines.map((r, n) => (
          <motion.li key={r.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(n, 8) * 0.03 }}>
            <RoutineRow r={r} />
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

function RoutineRow({ r }: { r: Routine }) {
  const { toggle, run, running } = useRoutineActions(r);
  return (
    <div className="group hover:bg-muted/40 relative flex items-center gap-4 px-5 py-4 transition-colors">
      <Tile className={cn(!r.enabled && "bg-muted text-muted-foreground")} />
      <Link to={`/routines/${r.id}`} className="min-w-0 flex-1 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:rounded-2xl">
        <p className="truncate text-[15px] font-medium">{r.name}</p>
        <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 truncate text-xs">
          <Clock className="size-3" aria-hidden /> {cadence(r)}
          <span aria-hidden>·</span>
          <span className="truncate">{r.enabled ? `Next ${ago(nextRunAt(r).toISOString())}` : "Paused"}</span>
        </p>
      </Link>
      <div className="hidden w-44 min-w-0 text-[13px] md:block">
        <TargetChip r={r} />
      </div>
      <div className="relative z-10 flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100" disabled={running} onClick={run} aria-label={`Run ${r.name} now`}>
          <Play aria-hidden /> Run
        </Button>
        <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate(v)} aria-label={`${r.enabled ? "Pause" : "Resume"} ${r.name}`} />
        <ChevronRight className="text-muted-foreground size-4 transition group-hover:translate-x-0.5" aria-hidden />
      </div>
    </div>
  );
}

/* ───────────── view ───────────── */

export function RoutineDetail() {
  const { id } = useParams();
  const org = useOrg();
  const { data = [], isPending } = useRoutines(org.id);
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const r = data.find((x) => x.id === id);
  if (isPending)
    return (
      <Page>
        <Skeleton className="h-96 rounded-2xl" />
      </Page>
    );
  if (!r) return <ErrorPage code={404} compact />;
  return <Detail r={r} workspaces={workspaces} />;
}

function Detail({ r, workspaces }: { r: Routine; workspaces: Workspace[] }) {
  const navigate = useNavigate();
  const { toggle, remove, run, running } = useRoutineActions(r);
  const [confirm, setConfirm] = useState(false);
  const folders = workspaces.filter((w) => r.workspaceIds.includes(w.id));
  const { data: all = [] } = useTickets(useOrg().id);
  const runs = all.filter((t) => t.routineId === r.id).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return (
    <Page>
      <Back to="/routines">Routines</Back>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Tile className="size-12 rounded-2xl" />
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{r.name}</h1>
              <Status on={r.enabled} />
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{cadence(r)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={running}>
            <Play aria-hidden /> Run now
          </Button>
          <Button variant="outline" asChild>
            <Link to={`/routines/${r.id}/edit`}>
              <Pencil aria-hidden /> Edit
            </Link>
          </Button>
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirm(true)} aria-label="Remove routine">
            <Trash2 aria-hidden />
          </Button>
        </div>
      </header>

      <div className="mb-6 grid gap-px overflow-hidden rounded-2xl border bg-border shadow-xs sm:grid-cols-3">
        <Stat label="Next run" value={r.enabled ? ago(nextRunAt(r).toISOString()) : "Paused"} sub={r.enabled ? when(nextRunAt(r)) : "Resume to schedule"} />
        <Stat label="Last run" value={r.lastRunAt ? ago(r.lastRunAt) : "Never"} sub={r.lastRunAt ? when(new Date(r.lastRunAt)) : "Not run yet"} />
        <div className="bg-card flex items-center justify-between gap-3 p-5">
          <div>
            <p className="text-muted-foreground text-xs">Status</p>
            <p className="mt-1 text-[15px] font-medium">{r.enabled ? "Running on schedule" : "Paused"}</p>
          </div>
          <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Enabled" />
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_18rem]">
        <section className="bg-card rounded-2xl border p-6 shadow-xs">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Ticket template</p>
          <h2 className="mt-3 text-lg font-semibold">{r.title}</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">The run date is appended to the title.</p>
          <div className="mt-5 border-t pt-5">
            {r.body.trim() ? (
              <div className="md">
                <Markdown>{r.body}</Markdown>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">No description.</p>
            )}
          </div>
        </section>

        <aside className="bg-card divide-y rounded-2xl border shadow-xs">
          <Prop label="Runs with">
            <TargetChip r={r} />
          </Prop>
          <Prop label="Schedule">{cadence(r)}</Prop>
          <Prop label="Folders">
            {folders.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {folders.map((w) => (
                  <li key={w.id} className="bg-muted inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs">
                    <FolderGit2 className="size-3" aria-hidden /> {w.name}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </Prop>
          <Prop label="Next run">{nextText(r)}</Prop>
        </aside>
      </div>

      <section className="mt-6">
        <h2 className="text-muted-foreground mb-2 px-1 text-xs font-medium tracking-wide uppercase">
          Tickets created <span className="tabular-nums">· {runs.length}</span>
        </h2>
        {runs.length === 0 ? (
          <p className="text-muted-foreground bg-card rounded-2xl border border-dashed px-5 py-8 text-center text-sm">No tickets yet. Run now or wait for the schedule.</p>
        ) : (
          <ul className="bg-card divide-y overflow-hidden rounded-2xl border shadow-xs">
            {runs.map((t) => (
              <li key={t.id}>
                <Link to={`/t/${t.identifier}`} className="hover:bg-muted/40 flex items-center gap-3 px-5 py-3 text-[13px] transition-colors">
                  <StatusIcon status={t.status} className="size-4" />
                  <span className="text-muted-foreground w-16 shrink-0 tabular-nums">{t.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="text-muted-foreground hidden shrink-0 sm:inline">{STATUS[t.status].label}</span>
                  <span className="text-muted-foreground w-24 shrink-0 text-right text-xs">{ago(t.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove ${r.name}?`} desc="Tickets it already created stay. No new ones will be made." action="Remove" pending={remove.isPending} onConfirm={() => remove.mutate(undefined, { onSuccess: () => navigate("/routines") })} />
    </Page>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: string; sub: string }) => (
  <div className="bg-card p-5">
    <p className="text-muted-foreground text-xs">{label}</p>
    <p className="mt-1 text-[15px] font-medium">{value}</p>
    <p className="text-muted-foreground mt-0.5 truncate text-xs">{sub}</p>
  </div>
);

const Prop = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid gap-1.5 p-4 text-[13px]">
    <p className="text-muted-foreground text-xs">{label}</p>
    <div className="min-w-0">{children}</div>
  </div>
);

/* ───────────── edit / new ───────────── */

export function RoutineEditor() {
  const { id } = useParams();
  const org = useOrg();
  const { data = [], isPending } = useRoutines(org.id);
  const r = data.find((x) => x.id === id);
  if (id && isPending)
    return (
      <Page>
        <Skeleton className="h-96 rounded-2xl" />
      </Page>
    );
  if (id && !r) return <ErrorPage code={404} compact />;
  return <Editor routine={r} />;
}

type Mode = "pipeline" | "zipper" | "none";

const Card = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <section className="bg-card grid gap-4 rounded-2xl border p-6 shadow-xs">
    <div>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
    </div>
    {children}
  </section>
);

function Editor({ routine }: { routine?: Routine }) {
  const org = useOrg();
  const navigate = useNavigate();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { pipelines, agents } = useTarget(BLANK);
  const [form, setForm] = useState<RoutineInput>(routine ? toInput(routine) : BLANK);
  const [mode, setMode] = useState<Mode>(form.pipelineId ? "pipeline" : form.assigneeAgentId ? "zipper" : "none");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const back = routine ? `/routines/${routine.id}` : "/routines";
  const save = useApiMutation((v: RoutineInput) => (routine ? api.patch<Routine>(`/routines/${routine.id}`, v) : api.post<Routine>(`/orgs/${org.id}/routines`, v)), [keys.res(org.id, "routines")]);
  const set = <K extends keyof RoutineInput>(k: K, v: RoutineInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const pick = (m: Mode) => {
    setMode(m);
    setForm((f) => ({ ...f, pipelineId: m === "pipeline" ? f.pipelineId : null, assigneeAgentId: m === "zipper" ? f.assigneeAgentId : null }));
  };
  const preview = nextRunAt({ ...form, lastRunAt: routine?.lastRunAt ?? null, createdAt: routine?.createdAt ?? new Date().toISOString() });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = routineInput.safeParse(form);
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(r.data, { onSuccess: (saved) => navigate(`/routines/${routine?.id ?? saved.id}`) });
  }

  return (
    <Page>
      <Back to={back}>{routine ? routine.name : "Routines"}</Back>
      <form onSubmit={submit} noValidate aria-label={routine ? `Routine ${routine.name}` : "New routine"}>
        <header className="mb-8 flex items-end justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{routine ? "Edit routine" : "New routine"}</h1>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate(back)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              <Check aria-hidden /> {routine ? "Save changes" : "Create routine"}
            </Button>
          </div>
        </header>

        <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="grid gap-6">
            <Card title="Ticket template" hint="Every run creates a ticket from this.">
              <Field label="Name" error={errors.name}>{(p) => <Input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Weekly dependency bump" autoFocus={!routine} />}</Field>
              <Field label="Ticket title" hint="The run date is appended." error={errors.title}>{(p) => <Input {...p} value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Bump dependencies" />}</Field>
              <Field label="Description">{(p) => <MdEditor id={p.id} value={form.body} onChange={(v) => set("body", v)} className="min-h-32" placeholder="What should the Zipper do?" />}</Field>
            </Card>

            <Card title="Schedule">
              <div role="radiogroup" aria-label="Frequency" className="bg-muted inline-flex w-fit gap-0.5 rounded-lg p-0.5">
                {PRESETS.map((p) => (
                  <Seg key={p.hours} on={form.everyHours === p.hours} onClick={() => set("everyHours", p.hours)}>
                    {p.label}
                  </Seg>
                ))}
              </div>
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <Field label="Every (hours)" error={errors.everyHours}>
                  {(p) => <Input {...p} type="number" min={1} value={form.everyHours} onChange={(e) => set("everyHours", Number(e.target.value))} />}
                </Field>
                <Field label="At (optional)" hint="Empty = every N hours from now." error={errors.runAt}>
                  {(p) => <Input {...p} type="time" value={form.runAt ?? ""} onChange={(e) => set("runAt", e.target.value || null)} />}
                </Field>
              </div>
              <p className="bg-muted/60 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]">
                <Clock className="text-muted-foreground size-3.5" aria-hidden />
                <span>
                  {cadence(form)} · next run <b className="font-medium">{when(preview)}</b>
                </span>
              </p>
            </Card>
          </div>

          <div className="grid gap-6">
            <Card title="Runs with" hint="Who picks the ticket up.">
              <div role="radiogroup" aria-label="Runs with" className="bg-muted grid grid-cols-3 gap-0.5 rounded-lg p-0.5">
                <Seg on={mode === "pipeline"} onClick={() => pick("pipeline")}>
                  Pipeline
                </Seg>
                <Seg on={mode === "zipper"} onClick={() => pick("zipper")}>
                  Zipper
                </Seg>
                <Seg on={mode === "none"} onClick={() => pick("none")}>
                  None
                </Seg>
              </div>
              {mode === "pipeline" && (
                <Field label="Pipeline" hint="Needs at least one folder.">
                  {(p) => <OptionSelect id={p.id} label="Pipeline" value={form.pipelineId ?? ""} onChange={(v) => set("pipelineId", v || null)} options={[{ value: "", label: "Choose pipeline" }, ...pipelines.map((x: Pipeline) => ({ value: x.id, label: x.name }))]} />}
                </Field>
              )}
              {mode === "zipper" && (
                <Field label="Zipper">
                  {(p) => <OptionSelect id={p.id} label="Zipper" value={form.assigneeAgentId ?? ""} onChange={(v) => set("assigneeAgentId", v || null)} options={[{ value: "", label: "Choose Zipper" }, ...agents.map((a: Agent) => ({ value: a.id, label: `${a.name} (@${a.handle})` }))]} />}
                </Field>
              )}
              {mode === "none" && <p className="text-muted-foreground text-xs">Only creates the ticket. Assign it yourself.</p>}
            </Card>

            <Card title="Folders" hint="Repos the ticket can touch.">
              {workspaces.length === 0 && <p className="text-muted-foreground text-xs">No folders yet.</p>}
              <div className="flex flex-wrap gap-2">
                {workspaces.map((w) => {
                  const on = form.workspaceIds.includes(w.id);
                  return (
                    <button
                      key={w.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("workspaceIds", on ? form.workspaceIds.filter((x) => x !== w.id) : [...form.workspaceIds, w.id])}
                      className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] transition", on ? "border-primary/50 bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted")}
                    >
                      {on ? <Check className="size-3.5" aria-hidden /> : <FolderGit2 className="size-3.5" aria-hidden />} {w.name}
                    </button>
                  );
                })}
              </div>
            </Card>

            <section className="bg-card flex items-center justify-between gap-3 rounded-2xl border p-5 shadow-xs">
              <div>
                <p className="text-[13px] font-medium">Enabled</p>
                <p className="text-muted-foreground text-xs">Paused routines never run.</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Enabled" />
            </section>
          </div>
        </div>
      </form>
    </Page>
  );
}

const Seg = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => (
  <button type="button" role="radio" aria-checked={on} onClick={onClick} className={cn("rounded-md px-3 py-1 text-[13px] font-medium transition", on ? "bg-background text-foreground ring-border shadow-xs ring-1" : "text-muted-foreground hover:text-foreground")}>
    {children}
  </button>
);
