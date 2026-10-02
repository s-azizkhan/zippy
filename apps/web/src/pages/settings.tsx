import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { mcpServerInput, orgInput, patchOf, workspaceInput, type McpServer, type McpServerInput, type Workspace, type WorkspaceInput } from "@zippy/shared";
import { Field, fieldErrors } from "@/components/field";
import { ToggleList } from "@/components/toggle-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, keys, useApiMutation, useMcpServers, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";

export function SettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <Tabs defaultValue={new URLSearchParams(location.search).has("linear") ? "linear" : "org"} className="mx-auto max-w-3xl gap-6 px-6 py-8">
          <TabsList>
            <TabsTrigger value="org">Organization</TabsTrigger>
            <TabsTrigger value="folders">Working folders</TabsTrigger>
            <TabsTrigger value="mcp">MCP servers</TabsTrigger>
            <TabsTrigger value="tools">Skills & MCP</TabsTrigger>
            <TabsTrigger value="linear">Linear</TabsTrigger>
          </TabsList>
          <TabsContent value="org">
            <OrgSettings />
          </TabsContent>
          <TabsContent value="folders">
            <Folders />
          </TabsContent>
          <TabsContent value="mcp">
            <McpServers />
          </TabsContent>
          <TabsContent value="tools">
            <OrgTools />
          </TabsContent>
          <TabsContent value="linear">
            <LinearSettings />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function OrgTools() {
  const org = useOrg();
  const save = useApiMutation((toggles: Record<string, boolean>) => api.patch(`/orgs/${org.id}`, { toggles }), [keys.orgs]);
  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-xs">Defaults for every agent. Override per agent on the Agents page.</p>
      <ToggleList toggles={org.toggles} onChange={(t) => save.mutate(t)} />
    </div>
  );
}

function OrgSettings() {
  const org = useOrg();
  const [form, setForm] = useState({ name: org.name, contextMd: org.contextMd, budgetUsd: org.budgetUsd });
  const save = useApiMutation((v: typeof form) => api.patch(`/orgs/${org.id}`, patchOf(orgInput).parse(v)), [keys.orgs]);
  return (
    <form onSubmit={(e) => (e.preventDefault(), save.mutate(form))} className="grid gap-5">
      <Field label="Name">{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
      <Field label="Agent budget per ticket (USD)" hint="Agents stop and ask you when a ticket's total spend reaches this. Empty = no limit.">
        {(p) => (
          <Input
            {...p}
            type="number"
            min={0.5}
            step={0.5}
            inputMode="decimal"
            value={form.budgetUsd ?? ""}
            onChange={(e) => setForm({ ...form, budgetUsd: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="No limit"
            className="w-40"
          />
        )}
      </Field>
      <Field label="Organization context" hint="Markdown. Every agent gets this: product, conventions, people, rules.">
        {(p) => <Textarea {...p} value={form.contextMd} onChange={(e) => setForm({ ...form, contextMd: e.target.value })} className="min-h-80 font-mono text-[13px]" />}
      </Field>
      <div>
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

const BLANK_WS: WorkspaceInput = { name: "", path: "", baseBranch: "main", setupCmd: "", testCmd: "", contextMd: "", riskPaths: [] };

function Folders() {
  const org = useOrg();
  const { data = [] } = useWorkspaces(org.id);
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid gap-4">
      {data.map((w) => (
        <FolderForm key={w.id} ws={w} />
      ))}
      {adding ? (
        <FolderForm onDone={() => setAdding(false)} />
      ) : (
        <Button variant="outline" className="justify-self-start" onClick={() => setAdding(true)}>
          <Plus aria-hidden /> Add working folder
        </Button>
      )}
    </div>
  );
}

function FolderForm({ ws, onDone }: { ws?: Workspace; onDone?: () => void }) {
  const org = useOrg();
  const [form, setForm] = useState<WorkspaceInput>(ws ?? BLANK_WS);
  const [riskText, setRiskText] = useState(form.riskPaths.join("\n"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inv = [keys.res(org.id, "workspaces")];
  const save = useApiMutation((v: WorkspaceInput) => (ws ? api.patch(`/workspaces/${ws.id}`, v) : api.post(`/orgs/${org.id}/workspaces`, v)), inv);
  const remove = useApiMutation(() => api.del(`/workspaces/${ws!.id}`), inv);
  const set = (k: keyof WorkspaceInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = workspaceInput.safeParse({ ...form, riskPaths: riskText.split("\n").map((l) => l.trim()).filter(Boolean) });
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(r.data, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border p-4" noValidate aria-label={ws ? `Folder ${ws.name}` : "New folder"}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" error={errors.name}>{(p) => <Input {...p} value={form.name} onChange={set("name")} />}</Field>
        <Field label="Base branch">{(p) => <Input {...p} value={form.baseBranch} onChange={set("baseBranch")} className="font-mono" />}</Field>
      </div>
      <Field label="Absolute path" error={errors.path}>{(p) => <Input {...p} value={form.path} onChange={set("path")} className="font-mono text-[13px]" />}</Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Setup command">{(p) => <Input {...p} value={form.setupCmd} onChange={set("setupCmd")} placeholder="pnpm install" className="font-mono text-[13px]" />}</Field>
        <Field label="Test command">{(p) => <Input {...p} value={form.testCmd} onChange={set("testCmd")} placeholder="pnpm test" className="font-mono text-[13px]" />}</Field>
      </div>
      <Field label="Protected paths" hint="One per line. Path prefixes or globs (e.g. src/payments, **/migrations/**). A PR touching these waits for your approval.">
        {(p) => (
          <Textarea
            {...p}
            value={riskText}
            onChange={(e) => setRiskText(e.target.value)}
            placeholder={"src/payments\n**/migrations/**\n.env*"}
            className="min-h-20 font-mono text-[13px]"
          />
        )}
      </Field>
      <Field label="Folder context" hint="Markdown. Added after org context. The repo's CLAUDE.md is loaded too.">
        {(p) => <Textarea {...p} value={form.contextMd} onChange={set("contextMd")} className="min-h-32 font-mono text-[13px]" />}
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {ws ? "Save" : "Add folder"}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        {ws && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive ml-auto" onClick={() => confirm(`Remove ${ws.name}?`) && remove.mutate(undefined)}>
            <Trash2 aria-hidden /> Remove
          </Button>
        )}
      </div>
    </form>
  );
}

const BLANK_MCP: McpServerInput = { name: "", workspaceId: null, transport: "stdio", command: "", args: [], url: "", env: {}, enabled: true };
const envToText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
const textToEnv = (t: string) => Object.fromEntries(t.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

function McpServers() {
  const org = useOrg();
  const { data = [] } = useMcpServers(org.id);
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-[13px]">Servers here are given to every agent session. Scope one to a folder to limit it.</p>
      {data.map((m) => (
        <McpForm key={m.id} server={m} />
      ))}
      {adding ? (
        <McpForm onDone={() => setAdding(false)} />
      ) : (
        <Button variant="outline" className="justify-self-start" onClick={() => setAdding(true)}>
          <Plus aria-hidden /> Add MCP server
        </Button>
      )}
    </div>
  );
}

function McpForm({ server, onDone }: { server?: McpServer; onDone?: () => void }) {
  const org = useOrg();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const [form, setForm] = useState<McpServerInput>(server ?? BLANK_MCP);
  const [envText, setEnvText] = useState(envToText(form.env));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inv = [keys.res(org.id, "mcp")];
  const save = useApiMutation((v: McpServerInput) => (server ? api.patch(`/mcp/${server.id}`, v) : api.post(`/orgs/${org.id}/mcp`, v)), inv);
  const remove = useApiMutation(() => api.del(`/mcp/${server!.id}`), inv);
  const ALL = "all";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = mcpServerInput.safeParse({ ...form, env: textToEnv(envText) });
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(r.data, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border p-4" noValidate aria-label={server ? `MCP server ${server.name}` : "New MCP server"}>
      <div className="grid grid-cols-3 gap-4">
        <Field label="Name" error={errors.name}>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Transport">
          {(p) => (
            <Select value={form.transport} onValueChange={(v) => setForm({ ...form, transport: v as "stdio" | "http" })}>
              <SelectTrigger {...p} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http">http</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Scope">
          {(p) => (
            <Select value={form.workspaceId ?? ALL} onValueChange={(v) => setForm({ ...form, workspaceId: v === ALL ? null : v })}>
              <SelectTrigger {...p} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All folders</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>
      {form.transport === "stdio" ? (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Command">{(p) => <Input {...p} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" className="font-mono text-[13px]" />}</Field>
          <Field label="Arguments" hint="Space-separated.">
            {(p) => <Input {...p} value={form.args.join(" ")} onChange={(e) => setForm({ ...form, args: e.target.value.split(" ").filter(Boolean) })} placeholder="-y @org/mcp-server" className="font-mono text-[13px]" />}
          </Field>
        </div>
      ) : (
        <Field label="URL">{(p) => <Input {...p} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/mcp" className="font-mono text-[13px]" />}</Field>
      )}
      <Field label={form.transport === "stdio" ? "Environment" : "Headers"} hint="One KEY=VALUE per line. Stored in plaintext in the local DB.">
        {(p) => <Textarea {...p} value={envText} onChange={(e) => setEnvText(e.target.value)} className="min-h-20 font-mono text-[13px]" />}
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {server ? "Save" : "Add server"}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        <label className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
          Enabled <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
        </label>
        {server && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => confirm(`Remove ${server.name}?`) && remove.mutate(undefined)}>
            <Trash2 aria-hidden /> Remove
          </Button>
        )}
      </div>
    </form>
  );
}

function LinearSettings() {
  const org = useOrg();
  const disconnect = useApiMutation(() => api.del(`/orgs/${org.id}/linear`), [keys.orgs]);
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <p className="text-[13px] font-medium">{org.linearConnected ? `Connected to ${org.linearWorkspace}` : "Not connected"}</p>
          <p className="text-muted-foreground text-xs">
            Connects through the Linear MCP server. Agents post to Linear as you, with their name in the comment, ticket status syncs, and every agent gets the Linear MCP server.
          </p>
        </div>
        {org.linearConnected ? (
          <Button variant="outline" size="sm" onClick={() => confirm("Disconnect Linear?") && disconnect.mutate(undefined)}>
            Disconnect
          </Button>
        ) : (
          <Button asChild size="sm">
            <a href={`/api/linear/connect?orgId=${org.id}`}>Connect Linear</a>
          </Button>
        )}
      </div>
      <div className="text-muted-foreground grid gap-2 rounded-lg border p-4 text-xs">
        <p className="text-foreground text-[13px] font-medium">Webhook (optional)</p>
        <ol className="grid list-decimal gap-1 pl-4">
          <li>
            Optional, for Linear comments to reach agents: expose the server (e.g. a tunnel), add a webhook to <code className="bg-muted rounded px-1">/api/linear/webhook</code> with Comment events, and set{" "}
            <code className="bg-muted rounded px-1">LINEAR_WEBHOOK_SECRET</code>.
          </li>
        </ol>
      </div>
    </div>
  );
}
