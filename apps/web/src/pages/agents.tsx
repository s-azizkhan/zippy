import { ChevronLeft, ChevronRight, Dices, Pencil, Trash2 } from "lucide-react";
import { EyeIcon as Eye } from "@/components/ui/eye";
import { FlaskIcon as FlaskConical } from "@/components/ui/flask";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import type { AgentWork, Ticket } from "@zippy/shared";
import { agentInput, EFFORTS, MODELS, type Agent, type AgentInput } from "@zippy/shared";
import { Field, fieldErrors } from "@/components/field";
import { AgentFace, encodeFace, FACE_PARTS, faceOf, PALETTE_IDS, PALETTES, paletteOf, randomFace, type FacePart } from "@/components/agent-face";
import { MdEditor } from "@/components/md-editor";
import { AgentAvatar, STATUS, StatusIcon } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ToggleList } from "@/components/toggle-list";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { FoldersPicker } from "@/components/pickers";
import { OptionSelect } from "@/components/property-menu";
import { api, keys, useAgentWork, useAgents, useApiMutation, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { ago, cn } from "@/lib/utils";

const TEMPLATE = `# Role

You are a ... Describe what this Zipper is responsible for.

# How you work

- Read the ticket and the relevant code first.
- Keep changes small. Reuse existing code.
- (Add the rules this agent must follow.)

# Do not

- Change code outside the ticket scope.
- (Add what this agent must never do.)

# Output

- Lead with the answer. Then the evidence: file paths, lines, commands run.
`;

const BLANK: AgentInput = { name: "", handle: "", rolePromptMd: TEMPLATE, model: "default", effort: "default", canWrite: false, color: "arctic-blue", toggles: {} };

const STARTERS: { label: string; canWrite: boolean; color: string; rolePromptMd: string }[] = [
  { label: "Reviewer", canWrite: false, color: "arctic-blue", rolePromptMd: "# Role\n\nYou review code changes.\n\n- Look for bugs, security issues and missing tests.\n- Cite file and line for every finding.\n- Do not change code.\n" },
  { label: "Builder", canWrite: true, color: "lime-lagoon", rolePromptMd: "# Role\n\nYou implement tickets.\n\n- Keep the diff small. Match the style around it.\n- Run the type check and tests before you report done.\n" },
  { label: "Researcher", canWrite: false, color: "orchid-peach", rolePromptMd: "# Role\n\nYou investigate questions about the codebase.\n\n- Find the relevant code first, then answer.\n- Lead with the answer, then the evidence.\n- Do not change code.\n" },
];

const PART_LABEL: Record<FacePart, string> = { body: "Body", eye: "Eyes", mouth: "Mouth", gear: "Extra" };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 30);
const blurb = (md: string) => md.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.replace(/^[-*]\s*/, "") ?? "No role prompt yet.";

export function AgentsPage() {
  const org = useOrg();
  const { handle } = useParams();
  const navigate = useNavigate();
  const { data: agents = [], isLoading } = useAgents(org.id);
  const current = agents.find((a) => a.handle === handle);
  if (handle === "new" || current) return <AgentStudio key={handle} agent={current} onClose={(a) => navigate(a ? `/zippers/${a.handle}` : "/zippers")} />;
  if (handle) return isLoading ? null : <Navigate to="/zippers" replace />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Zippers</h1>
            <p className="text-muted-foreground mt-1 text-sm">Your team. Each Zipper has its own role, model and tools. Mention one as @handle on any ticket.</p>
          </div>
          <Button onClick={() => navigate("/zippers/new")}>
            <Plus aria-hidden /> New agent
          </Button>
        </header>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((a, n) => (
            <motion.li key={a.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(n, 8) * 0.04 }}>
              <Link to={`/zippers/${a.handle}`} className="group agent-card lift bg-card hover:border-primary/40 hover:shadow-primary/5 relative grid h-full w-full gap-4 overflow-hidden rounded-2xl border p-5 text-left shadow-xs transition hover:-translate-y-0.5 hover:shadow-lg">
                <span aria-hidden className="absolute inset-x-0 top-0 h-24 opacity-[.14]" style={{ background: `linear-gradient(${paletteOf(a.color, a.id).a}, transparent)` }} />
                <AgentAvatar agent={a} track className="relative size-20 transition group-hover:scale-105" />
                <div className="relative min-w-0">
                  <h2 className="truncate text-[15px] font-semibold">{a.name}</h2>
                  <p className="text-muted-foreground font-mono text-xs">@{a.handle}</p>
                </div>
                <p className="text-muted-foreground line-clamp-2 min-h-8 text-xs">{blurb(a.rolePromptMd)}</p>
                <div className="text-muted-foreground flex items-center gap-2 border-t pt-3 text-xs">
                  <span className="bg-muted inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-medium">
                    {a.canWrite ? <Pencil className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
                    {a.canWrite ? "Can edit" : "Read-only"}
                  </span>
                  <span className="min-w-0 truncate font-mono" title={a.model}>{a.effort !== "default" ? `${a.model} · ${a.effort}` : a.model}</span>
                  <ChevronRight className="ml-auto size-4 shrink-0 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
                </div>
              </Link>
            </motion.li>
          ))}
          <li>
            <Link to="/zippers/new" className="text-muted-foreground hover:border-primary/40 hover:text-primary grid h-full min-h-56 w-full place-items-center content-center gap-1 rounded-2xl border border-dashed p-5 text-sm transition">
              <Plus className="size-5" aria-hidden /> New agent
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}

function AgentStudio({ agent, onClose }: { agent: Agent | undefined; onClose: (a: Agent | null) => void }) {
  const org = useOrg();
  const [draft] = useState<AgentInput>(() => ({ ...BLANK, color: randomFace() }));
  const initial: AgentInput = agent ? { ...agent, color: encodeFace(faceOf(agent.color, agent.id)) } : draft;
  const [form, setForm] = useState<AgentInput>(initial);
  const [handleTouched, setHandleTouched] = useState(!!agent);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.res(org.id, "agents")];
  const save = useApiMutation((v: AgentInput) => (agent ? api.patch<Agent>(`/agents/${agent.id}`, v) : api.post<Agent>(`/orgs/${org.id}/agents`, v)), invalidate);
  const remove = useApiMutation(() => api.del(`/agents/${agent!.id}`), invalidate);
  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { data: agents = [] } = useAgents(org.id);
  const [faceTouched, setFaceTouched] = useState(!!agent);
  const pick = (c: string) => (setFaceTouched(true), set("color", c));
  /** Face from the name; palette prefers one no other agent uses. */
  const faceFromName = (name: string) => {
    const f = faceOf("", name);
    const taken = new Set(agents.map((a) => faceOf(a.color, a.id).id));
    const free = PALETTE_IDS.filter((id) => !taken.has(id));
    const pool = free.length ? free : PALETTE_IDS;
    return encodeFace({ ...f, id: pool[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % pool.length]! });
  };
  const work = useAgentWork(agent?.id).data;
  const live = work?.find((w) => w.running);
  const [lab, setLab] = useState(false);
  const labRef = useRef<HTMLDetailsElement>(null);
  const seedOf = agent?.id ?? "";
  const face = faceOf(form.color, seedOf);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = agentInput.safeParse(form);
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(r.data, { onSuccess: (a) => (agent && setForm({ ...a, color: encodeFace(faceOf(a.color, a.id)) }), onClose(a)) });
  }

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !save.isPending) formRef.current?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save.isPending]);

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-6 px-6 pt-6 pb-28">
        <div className="flex items-center justify-between">
          <Button type="button" variant="ghost" size="sm" onClick={() => onClose(null)}>
            <ChevronLeft aria-hidden /> Zippers
          </Button>
          {agent && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => confirm(`Delete ${agent.name}?`) && remove.mutate(undefined, { onSuccess: () => onClose(null) })}>
              <Trash2 aria-hidden /> Delete
            </Button>
          )}
        </div>

        <section className="bg-card relative grid gap-6 overflow-hidden rounded-3xl border p-6 sm:grid-cols-[auto_1fr] sm:items-center">
          <span aria-hidden className="absolute inset-x-0 top-0 h-32 opacity-[.12] transition-colors" style={{ background: `linear-gradient(${face.a}, transparent)` }} />
          <motion.div key={form.name.length} initial={{ scale: 0.94, rotate: -5 }} animate={{ scale: 1, rotate: 0 }} className="relative mx-auto">
            <AgentAvatar agent={{ id: agent?.id, name: form.name || "?", color: form.color }} track running={!!live} className="size-32" />
            <button type="button" aria-label="Edit face" title="Edit face" onClick={() => (setLab(true), requestAnimationFrame(() => labRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })))}
              className="bg-background hover:bg-accent absolute right-1 bottom-2 grid size-8 place-items-center rounded-full border shadow-sm transition">
              <Pencil className="size-3.5" aria-hidden />
            </button>
          </motion.div>
          <div className="relative grid gap-3">
            <div>
              <Input aria-label="Name" placeholder="Name your Zipper" value={form.name} aria-invalid={!!errors.name || undefined} autoFocus={!agent}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({ ...f, name, ...(!handleTouched && { handle: slug(name) }), ...(!agent && !faceTouched && name.trim() && { color: faceFromName(name.trim().toLowerCase()) }) }));
                }}
                className="h-auto border-0 bg-transparent px-0 text-3xl font-semibold tracking-tight shadow-none focus-visible:ring-0 md:text-3xl dark:bg-transparent" />
              {errors.name && <p className="text-destructive text-xs">{errors.name}</p>}
            </div>
            <div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground font-mono text-sm">@</span>
                <Input aria-label="Handle" placeholder="handle" value={form.handle} aria-invalid={!!errors.handle || undefined}
                  onChange={(e) => (setHandleTouched(true), set("handle", e.target.value.toLowerCase()))} className="h-7 max-w-48 font-mono" />
                <span className="text-muted-foreground ml-1 text-xs">mention in comments</span>
              </div>
              {agent && (
                <p className="mt-2 text-xs">
                  {live ? (
                    <Link to={`/t/${live.ticket.identifier}`} className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 font-medium text-green-600 dark:text-green-400">
                      <span className="size-1.5 animate-pulse rounded-full bg-green-500" /> Working on {live.ticket.identifier}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Idle{work?.[0] && ` · last on ${work[0].ticket.identifier} ${ago(work[0].ticket.updatedAt)}`}</span>
                  )}
                </p>
              )}
              {errors.handle && <p className="text-destructive text-xs">{errors.handle}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Palette">
              {PALETTE_IDS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={face.id === c} aria-label={c} onClick={() => pick(encodeFace({ ...face, id: c }))}
                  className={cn("size-5 rounded-full ring-offset-2 ring-offset-[var(--card)] transition hover:scale-110", face.id === c && "ring-2 ring-[var(--foreground)]")} style={{ background: `linear-gradient(${PALETTES[c][0]}, ${PALETTES[c][1]})` }} />
              ))}
              <Button type="button" size="sm" variant="outline" className="ml-1 rounded-full" onClick={() => pick(randomFace())}>
                <Dices aria-hidden /> Shuffle
              </Button>
            </div>
          </div>
        </section>

        {lab && (
        <details ref={labRef} className="bg-card rounded-2xl border p-4">
          <summary className="cursor-pointer text-[13px] font-medium select-none">Build the face</summary>
          <div className="mt-4 grid gap-4">
            {(Object.keys(FACE_PARTS) as FacePart[]).map((k) => (
              <div key={k} className="flex items-center gap-3">
                <span className="text-muted-foreground w-12 shrink-0 text-xs">{PART_LABEL[k]}</span>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={PART_LABEL[k]}>
                  {Array.from({ length: FACE_PARTS[k] }, (_, i) => (
                    <button key={i} type="button" role="radio" aria-checked={face[k] === i} aria-label={`${PART_LABEL[k]} ${i + 1}`} onClick={() => pick(encodeFace({ ...face, [k]: i }))}
                      className={cn("hover:bg-accent rounded-xl p-1 transition", face[k] === i && "bg-accent ring-primary ring-2")}>
                      <AgentFace seed={seedOf} color={encodeFace({ ...face, [k]: i })} className="size-10" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
        )}

        {!agent && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Start from</span>
            {STARTERS.map(({ label, ...s }) => (
              <Button key={label} type="button" size="sm" variant="outline" className="rounded-full" onClick={() => setForm((f) => ({ ...f, ...s, color: encodeFace({ ...faceOf(f.color, seedOf), id: s.color as keyof typeof PALETTES }), name: f.name || label, handle: handleTouched ? f.handle : slug(f.name || label) }))}>
                {label}
              </Button>
            ))}
          </div>
        )}

        <Tabs defaultValue={agent ? "work" : "behavior"}>
          <TabsList variant="line">
            {agent && <TabsTrigger value="work">Work{!!work?.length && <span className="text-muted-foreground ml-1 text-xs tabular-nums">{work.length}</span>}</TabsTrigger>}
            <TabsTrigger value="behavior">Behavior</TabsTrigger>
            <TabsTrigger value="tools">Rules & tools</TabsTrigger>
            {agent && <TabsTrigger value="test">Test run</TabsTrigger>}
          </TabsList>
          {agent && (
            <TabsContent value="work" className="mt-5">
              <WorkList work={work} />
            </TabsContent>
          )}
          <TabsContent value="behavior" className="mt-5 grid gap-5">
            <div role="radiogroup" aria-label="Access" className="grid gap-3 sm:grid-cols-2">
              {[
                { v: false, icon: Eye, title: "Read-only", hint: "Reviews and advises. File edits are blocked." },
                { v: true, icon: Pencil, title: "Can edit files", hint: "Writes code and runs commands in the folder." },
              ].map(({ v, icon: Icon, title, hint }) => (
                <button key={title} type="button" role="radio" aria-checked={form.canWrite === v} onClick={() => set("canWrite", v)}
                  className={cn("flex items-start gap-3 rounded-xl border p-4 text-left transition hover:border-primary/40", form.canWrite === v && "border-primary bg-primary/5 ring-1 ring-primary")}>
                  <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    <span className="block text-[13px] font-medium">{title}</span>
                    <span className="text-muted-foreground block text-xs">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
            <Field label="Model" hint="default uses the org default (Settings).">
              {(p) => (
                <OptionSelect id={p.id} label="Model" value={form.model} onChange={(v) => set("model", v)} options={(MODELS.includes(form.model) ? MODELS : [...MODELS, form.model]).map((m) => ({ value: m, label: m }))} />
              )}
            </Field>
            <Field label="Thinking level" hint="default uses the org default. Lower levels cost less; keep high ones for planning and building.">
              {(p) => <OptionSelect id={p.id} label="Thinking level" value={form.effort} onChange={(v) => set("effort", v)} options={EFFORTS.map((m) => ({ value: m, label: m }))} />}
            </Field>
            <Field label="Role prompt" hint="Markdown. Added to the Claude Code system prompt, after org and folder context.">
              {(p) => <MdEditor id={p.id} value={form.rolePromptMd} onChange={(v) => set("rolePromptMd", v)} className="min-h-72" />}
            </Field>
          </TabsContent>
          <TabsContent value="tools" className="mt-5">
            <p className="text-muted-foreground mb-4 text-xs">Overrides the org defaults in Settings.</p>
            <ToggleList toggles={form.toggles} base={org.toggles} onChange={(t) => set("toggles", t)} />
          </TabsContent>
          {agent && (
            <TabsContent value="test" className="mt-5">
              <TestRun agent={agent} dirty={dirty} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <div role="status" className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
        {(dirty || !agent) && (
          <div className="bg-popover pointer-events-auto animate-in fade-in-0 slide-in-from-bottom-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5 shadow-lg duration-300">
            <span className="flex items-center gap-2 text-[13px] font-medium">
              {agent && <span aria-hidden className="size-2 rounded-full bg-amber-500" />}
              {agent ? "Unsaved changes" : "New Zipper"}
            </span>
            <Button type="button" variant="ghost" size="sm" className="max-md:min-h-11" onClick={() => (agent ? (setForm(initial), setErrors({})) : onClose(null))}>
              {agent ? "Discard" : "Cancel"}
            </Button>
            <Button type="submit" size="sm" className="max-md:min-h-11" disabled={save.isPending || !dirty}>
              {agent ? "Save changes" : "Create Zipper"}
              <kbd aria-hidden className="bg-primary-foreground/20 hidden rounded px-1 font-mono text-[10px] sm:inline">
                ⌘S
              </kbd>
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}

function WorkList({ work }: { work: AgentWork[] | undefined }) {
  if (!work) return null;
  if (!work.length) return <p className="text-muted-foreground rounded-2xl border border-dashed p-8 text-center text-sm">No tickets yet. Assign this Zipper or mention @handle on a ticket.</p>;
  const cost = work.reduce((n, w) => n + w.costUsd, 0);
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-xs">
        {work.length} ticket{work.length === 1 ? "" : "s"} · {work.filter((w) => w.running).length} running · ${cost.toFixed(2)} total
      </p>
      <ul className="divide-y rounded-2xl border">
        {work.map(({ ticket: t, running, assigned, costUsd }) => (
          <li key={t.id}>
            <Link to={`/t/${t.identifier}`} className="hover:bg-accent/50 flex items-center gap-3 px-4 py-3 text-[13px] transition">
              <StatusIcon status={t.status} />
              <span className="text-muted-foreground font-mono text-xs">{t.identifier}</span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {running && <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400"><span className="size-1.5 animate-pulse rounded-full bg-green-500" /> Working</span>}
              {assigned && !running && <span className="bg-muted rounded-full px-2 py-0.5 text-xs">Assigned</span>}
              <span className="text-muted-foreground hidden text-xs sm:inline">{STATUS[t.status].label}</span>
              {costUsd > 0 && <span className="text-muted-foreground hidden font-mono text-xs sm:inline">${costUsd.toFixed(2)}</span>}
              <span className="text-muted-foreground w-20 text-right text-xs">{ago(t.updatedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Runs the agent on a throwaway ticket so you can check its prompt and tools before real work. */
function TestRun({ agent, dirty }: { agent: Agent; dirty: boolean }) {
  const org = useOrg();
  const navigate = useNavigate();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const folders = picked ?? (workspaces[0] ? [workspaces[0].id] : []);
  const run = useApiMutation(() => api.post<Ticket>(`/agents/${agent.id}/test`, { workspaceIds: folders, prompt }), [keys.res(org.id, "tickets")]);
  return (
    <div className="grid gap-3 rounded-2xl border p-5" role="group" aria-label={`Test run ${agent.name}`}>
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <FlaskConical className="size-4" aria-hidden /> Try @{agent.handle}
      </p>
      <p className="text-muted-foreground text-xs">Creates a "Test run" ticket with this prompt and runs the agent on it.{dirty && " Save changes first: the test uses the saved version."}</p>
      <Field label="Sample task">{(p) => <Textarea {...p} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Review the last commit for security issues." className="min-h-20 text-[13px]" />}</Field>
      <div className="flex items-end gap-2">
        <Field label="Folder">{() => <FoldersPicker orgId={org.id} value={folders} onChange={setPicked} />}</Field>
        <Button type="button" size="sm" disabled={!prompt.trim() || !folders.length || run.isPending} onClick={() => run.mutate(undefined, { onSuccess: (t) => navigate(`/t/${t.identifier}`) })}>
          {run.isPending ? "Starting…" : "Run test"}
        </Button>
      </div>
    </div>
  );
}
