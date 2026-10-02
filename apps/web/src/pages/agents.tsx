import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { agentInput, type Agent, type AgentInput } from "@zippy/shared";
import { Field, fieldErrors } from "@/components/field";
import { AgentAvatar } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ToggleList } from "@/components/toggle-list";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, keys, useAgents, useApiMutation } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const BLANK: AgentInput = { name: "", handle: "", rolePromptMd: "# Role\n\n", model: "default", canWrite: false, color: "#6366f1", toggles: {} };
const MODELS = ["default", "sonnet", "opus", "haiku"];

export function AgentsPage() {
  const org = useOrg();
  const { data: agents = [] } = useAgents(org.id);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const current = selected === "new" ? null : (agents.find((a) => a.id === selected) ?? agents[0]);

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-64 shrink-0 flex-col border-r" aria-label="Agents">
        <header className="flex h-12 items-center justify-between border-b px-4">
          <h1 className="text-[13px] font-semibold">Agents</h1>
          <Button size="icon-sm" variant="ghost" aria-label="New agent" onClick={() => setSelected("new")}>
            <Plus aria-hidden />
          </Button>
        </header>
        <ul className="overflow-y-auto p-2">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => setSelected(a.id)}
                aria-current={current?.id === a.id || undefined}
                className={cn("hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", current?.id === a.id && selected !== "new" && "bg-accent")}
              >
                <AgentAvatar agent={a} />
                <span className="flex-1 truncate">{a.name}</span>
                <span className="text-muted-foreground text-xs">@{a.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex-1 overflow-y-auto">
        <AgentEditor key={selected === "new" ? "new" : current?.id} agent={selected === "new" ? null : current} onSaved={setSelected} />
      </div>
    </div>
  );
}

function AgentEditor({ agent, onSaved }: { agent: Agent | null | undefined; onSaved: (id: string | null) => void }) {
  const org = useOrg();
  const [form, setForm] = useState<AgentInput>(agent ?? BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.res(org.id, "agents")];
  const save = useApiMutation((v: AgentInput) => (agent ? api.patch<Agent>(`/agents/${agent.id}`, v) : api.post<Agent>(`/orgs/${org.id}/agents`, v)), invalidate);
  const remove = useApiMutation(() => api.del(`/agents/${agent!.id}`), invalidate);
  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setForm({ ...form, [k]: v });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = agentInput.safeParse(form);
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(r.data, { onSuccess: (a) => onSaved(a.id) });
  }

  return (
    <form onSubmit={submit} className="mx-auto grid max-w-3xl gap-5 px-6 py-8" noValidate>
      <div className="flex items-center gap-3">
        <AgentAvatar agent={{ name: form.name || "?", color: form.color }} className="size-9 text-sm" />
        <h2 className="text-lg font-semibold">{agent ? agent.name : "New agent"}</h2>
        {agent && (
          <Button type="button" variant="ghost" size="sm" className="text-destructive ml-auto" onClick={() => confirm(`Delete ${agent.name}?`) && remove.mutate(undefined, { onSuccess: () => onSaved(null) })}>
            <Trash2 aria-hidden /> Delete
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" error={errors.name}>
          {(p) => <Input {...p} value={form.name} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <Field label="Handle" hint="Mention as @handle in comments." error={errors.handle}>
          {(p) => <Input {...p} value={form.handle} onChange={(e) => set("handle", e.target.value.toLowerCase())} className="font-mono" />}
        </Field>
        <Field label="Model" hint="default uses your Claude Code setting.">
          {(p) => (
            <>
              <Input {...p} list="models" value={form.model} onChange={(e) => set("model", e.target.value)} />
              <datalist id="models">
                {MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Color">
          {(p) => <Input {...p} type="color" value={form.color} onChange={(e) => set("color", e.target.value)} className="h-9 w-16 p-1" />}
        </Field>
      </div>
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <p id="can-write" className="text-[13px] font-medium">
            Can edit files
          </p>
          <p className="text-muted-foreground text-xs">Off = read-only reviewer. File edits are blocked.</p>
        </div>
        <Switch aria-labelledby="can-write" checked={form.canWrite} onCheckedChange={(v) => set("canWrite", v)} />
      </div>
      <Field label="Role prompt" hint="Markdown. Added to the Claude Code system prompt, after org and folder context.">
        {(p) => <Textarea {...p} value={form.rolePromptMd} onChange={(e) => set("rolePromptMd", e.target.value)} className="min-h-96 font-mono text-[13px]" />}
      </Field>
      <Field label="Skills & MCP" hint="Overrides the org defaults in Settings.">
        {() => <ToggleList toggles={form.toggles} base={org.toggles} onChange={(t) => set("toggles", t)} />}
      </Field>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {agent ? "Save changes" : "Create agent"}
        </Button>
      </div>
    </form>
  );
}
