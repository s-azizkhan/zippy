import { Building2, Check, ChevronRight, Copy, FolderGit2, Link2, Plug, Plus, Server, Trash2, Wrench, type LucideIcon } from "lucide-react";
import { Collapsible, Tabs as TabsPrimitive } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { EFFORTS, MODELS, mcpServerInput, orgInput, patchOf, workspaceInput, type McpServer, type McpServerInput, type Workspace, type WorkspaceInput } from "@zippy/shared";
import { Field, fieldErrors, SettingRow } from "@/components/field";
import { ToggleList } from "@/components/toggle-list";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, keys, useApiMutation, useAcp, useMcpServers, useSystem, useWorkspaces } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { SETTINGS_TABS, type SettingsTab } from "@/lib/settings-tabs";

const ICONS: Record<SettingsTab, LucideIcon> = { org: Building2, folders: FolderGit2, tools: Wrench, mcp: Server, connectors: Plug, linear: Link2 };
const GROUPS = [...new Set(SETTINGS_TABS.map((t) => t.group))];
const isTab = (v: string | null): v is SettingsTab => SETTINGS_TABS.some((t) => t.value === v);

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("tab");
  // `?linear=connected` is where the OAuth callback lands.
  const tab: SettingsTab = isTab(q) ? q : params.has("linear") ? "linear" : "org";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <TabsPrimitive.Root
          value={tab}
          onValueChange={(v) => setParams({ tab: v }, { replace: true })}
          orientation="vertical"
          className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 md:flex-row md:gap-10 md:px-6 md:py-8"
        >
          <TabsPrimitive.List aria-label="Settings sections" className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 pb-1 md:sticky md:top-0 md:mx-0 md:w-52 md:flex-col md:gap-0.5 md:self-start md:overflow-visible md:px-0 md:pb-0">
            {GROUPS.map((g) => (
              <div key={g} role="presentation" className="flex gap-1 md:flex-col md:gap-0.5">
                <span className="text-muted-foreground hidden px-3 pt-4 pb-1 text-[11px] font-medium tracking-wide uppercase first:pt-0 md:block" aria-hidden>
                  {g}
                </span>
                {SETTINGS_TABS.filter((t) => t.group === g).map((t) => {
                  const Icon = ICONS[t.value];
                  return (
                    <TabsPrimitive.Trigger
                      key={t.value}
                      value={t.value}
                      className="text-muted-foreground hover:text-foreground hover:bg-accent/60 data-[state=active]:bg-accent data-[state=active]:text-foreground focus-visible:ring-ring/60 relative inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] max-md:data-[state=active]:border-foreground/30 md:min-h-9 md:border-transparent md:before:absolute md:before:inset-y-2 md:before:-left-0 md:before:w-0.5 md:before:origin-center md:before:scale-y-0 md:before:rounded-full md:before:bg-foreground md:before:transition-transform md:data-[state=active]:before:scale-y-100"
                    >
                      <Icon aria-hidden className="size-4 shrink-0" />
                      {t.label}
                    </TabsPrimitive.Trigger>
                  );
                })}
              </div>
            ))}
          </TabsPrimitive.List>
          <div className="min-w-0 flex-1">
            <Pane value="org" title="Organization" desc="Identity, spending limits, notifications and shared context for every agent.">
              <OrgSettings active={tab === "org"} />
            </Pane>
            <Pane value="folders" title="Working folders" desc="Local repos agents work in. Each ticket gets an isolated worktree of one folder.">
              <Folders />
            </Pane>
            <Pane value="tools" title="Agent tool defaults" desc="Defaults for every agent. Override per agent on the Agents page.">
              <OrgTools />
            </Pane>
            <Pane value="mcp" title="MCP servers" desc="Servers given to every agent session. Scope one to a folder to limit it.">
              <McpServers />
            </Pane>
            <Pane value="connectors" title="Connectors" desc="Status of the services Zippy connects to.">
              <Connectors />
            </Pane>
            <Pane value="linear" title="Linear" desc="Sync tickets and comments with your Linear workspace.">
              <LinearSettings />
            </Pane>
          </div>
        </TabsPrimitive.Root>
      </div>
    </div>
  );
}

/** Panes stay mounted so unsaved edits survive tab switches; the animation replays when one becomes visible. */
function Pane({ value, title, desc, children }: { value: SettingsTab; title: string; desc: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Content value={value} forceMount className="animate-in fade-in-0 slide-in-from-bottom-1 grid gap-5 outline-none duration-300 data-[state=inactive]:hidden">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mt-0.5 text-[13px]">{desc}</p>
      </div>
      {children}
    </TabsPrimitive.Content>
  );
}

function Card({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="bg-card grid gap-4 rounded-xl border p-5 shadow-xs">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {desc && <p className="text-muted-foreground mt-0.5 text-xs">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ icon: Icon, title, desc, children }: { icon: LucideIcon; title: string; desc: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-1 rounded-xl border border-dashed px-6 py-10 text-center">
      <span className="bg-muted mb-2 grid size-10 place-items-center rounded-full">
        <Icon aria-hidden className="text-muted-foreground size-5" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-sm text-xs">{desc}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function ConfirmDialog({ open, onOpenChange, title, desc, action, onConfirm, pending }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; desc: string; action: string; onConfirm: () => void; pending?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Collapsed summary row; the body stays mounted (inert when closed) so edits survive collapsing. */
function Disclosure({ title, meta, badges, trailing, defaultOpen = false, children }: { title: string; meta?: string; badges?: ReactNode; trailing?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="bg-card rounded-xl border shadow-xs transition-shadow data-[state=open]:shadow-sm">
      <div className="flex items-center gap-3 pr-4">
        <Collapsible.Trigger className="group focus-visible:ring-ring/60 flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-[3px]">
          <ChevronRight aria-hidden className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{title || "Untitled"}</span>
            {meta && <span className="text-muted-foreground block truncate font-mono text-xs">{meta}</span>}
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 sm:flex">{badges}</span>
        </Collapsible.Trigger>
        {trailing}
      </div>
      <Collapsible.Content forceMount className="grid transition-[grid-template-rows] duration-300 ease-out data-[state=closed]:grid-rows-[0fr] data-[state=open]:grid-rows-[1fr]">
        <div inert={!open} className="min-h-0 overflow-hidden">
          <div className="border-t p-4 sm:p-5">{children}</div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

const Chip = ({ children }: { children: ReactNode }) => <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 font-mono text-[11px]">{children}</span>;

function OrgTools() {
  const org = useOrg();
  const save = useApiMutation((toggles: Record<string, boolean>) => api.patch(`/orgs/${org.id}`, { toggles }), [keys.orgs]);
  return <ToggleList toggles={org.toggles} onChange={(t) => save.mutate(t)} />;
}

function OrgSettings({ active }: { active: boolean }) {
  const org = useOrg();
  const base = { name: org.name, contextMd: org.contextMd, defaultModel: org.defaultModel, defaultEffort: org.defaultEffort, budgetUsd: org.budgetUsd ?? null, slackWebhookUrl: org.slackWebhookUrl.trim(), notifyDesktop: org.notifyDesktop };
  const baseKey = JSON.stringify(base);
  const [form, setForm] = useState(base);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(form) !== baseKey;
  const save = useApiMutation((v: typeof form) => api.patch(`/orgs/${org.id}`, patchOf(orgInput).parse(v)), [keys.orgs]);

  // Server data changed (refetch / other client): follow it unless the user has edits.
  const prevKey = useRef(baseKey);
  useEffect(() => {
    if (prevKey.current === baseKey) return;
    setForm((f) => (JSON.stringify(f) === prevKey.current ? base : f));
    prevKey.current = baseKey;
  }, [baseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    const r = patchOf(orgInput).safeParse(form);
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(form, { onSuccess: () => toast.success("Settings saved") });
  }
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!active || !dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!save.isPending) submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, dirty, save.isPending]);

  return (
    <form onSubmit={(e) => (e.preventDefault(), submit())} noValidate className="grid gap-5">
      <Card title="Identity">
        <Field label="Name" error={errors.name}>
          {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
      </Card>
      <Card title="Agent defaults" desc="Used by agents whose model is set to default. Empty picks follow your Claude Code setting.">
        {([["Model", "defaultModel", MODELS], ["Thinking level", "defaultEffort", EFFORTS]] as const).map(([label, k, opts]) => (
          <Field key={k} label={label}>
            {(p) => (
              <select {...p} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30">
                {(opts.includes(form[k]) ? opts : [...opts, form[k]]).map((m) => (
                  <option key={m} value={m} className="bg-background">
                    {m}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ))}
      </Card>
      <Card title="Budget" desc="Agents stop and ask you when a ticket's total spend reaches this limit.">
        <Field label="Agent budget per ticket (USD)" hint="Empty = no limit." error={errors.budgetUsd}>
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
      </Card>
      <Card title="Notifications" desc="Sent when a ticket needs input, is ready for review, or is blocked.">
        <SettingRow label="Desktop notifications" hint="macOS notification on those events.">
          {(p) => <Switch {...p} checked={form.notifyDesktop} onCheckedChange={(notifyDesktop) => setForm({ ...form, notifyDesktop })} />}
        </SettingRow>
        <Field label="Slack webhook" hint="Incoming webhook URL. Empty = off." error={errors.slackWebhookUrl}>
          {(p) => <Input {...p} value={form.slackWebhookUrl} onChange={(e) => setForm({ ...form, slackWebhookUrl: e.target.value.trim() })} placeholder="https://hooks.slack.com/services/…" className="font-mono text-[13px]" />}
        </Field>
      </Card>
      <Card title="Context" desc="Markdown. Every agent gets this: product, conventions, people, rules.">
        <Field label="Organization context" error={errors.contextMd}>
          {(p) => <Textarea {...p} value={form.contextMd} onChange={(e) => setForm({ ...form, contextMd: e.target.value })} className="min-h-80 font-mono text-[13px]" />}
        </Field>
      </Card>
      <div role="status" className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
        {dirty && !save.isPending && (
          <div className="bg-popover pointer-events-auto animate-in fade-in-0 slide-in-from-bottom-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5 shadow-lg duration-300">
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <span aria-hidden className="size-2 rounded-full bg-amber-500" />
              Unsaved changes
            </span>
            <Button type="button" variant="ghost" size="sm" className="max-md:min-h-11" onClick={() => (setForm(base), setErrors({}))}>
              Discard
            </Button>
            <Button type="submit" size="sm" className="max-md:min-h-11" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
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

const BLANK_WS: WorkspaceInput = { name: "", path: "", baseBranch: "main", setupCmd: "", testCmd: "", contextMd: "", riskPaths: [] };

function Folders() {
  const org = useOrg();
  const { data = [] } = useWorkspaces(org.id);
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid gap-3">
      {data.length === 0 && !adding && (
        <EmptyState icon={FolderGit2} title="No working folders yet" desc="Add a local git repo so agents have somewhere to work.">
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden /> Add working folder
          </Button>
        </EmptyState>
      )}
      {data.map((w) => (
        <Disclosure key={w.id} title={w.name} meta={w.path} badges={<>{w.baseBranch && <Chip>{w.baseBranch}</Chip>}{w.testCmd && <Chip>{w.testCmd}</Chip>}</>}>
          <FolderForm ws={w} />
        </Disclosure>
      ))}
      {adding && (
        <Disclosure title="New working folder" defaultOpen>
          <FolderForm onDone={() => setAdding(false)} />
        </Disclosure>
      )}
      {data.length > 0 && !adding && (
        <Button variant="outline" className="justify-self-start max-md:min-h-11" onClick={() => setAdding(true)}>
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
  const [confirming, setConfirming] = useState(false);
  const inv = [keys.res(org.id, "workspaces")];
  const save = useApiMutation((v: WorkspaceInput) => (ws ? api.patch(`/workspaces/${ws.id}`, v) : api.post(`/orgs/${org.id}/workspaces`, v)), inv);
  const remove = useApiMutation(() => api.del(`/workspaces/${ws!.id}`), inv);
  const set = (k: keyof WorkspaceInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = workspaceInput.safeParse({ ...form, riskPaths: riskText.split("\n").map((l) => l.trim()).filter(Boolean) });
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (r.success) save.mutate(r.data, { onSuccess: () => (toast.success(ws ? "Folder saved" : "Folder added"), onDone?.()) });
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate aria-label={ws ? `Folder ${ws.name}` : "New folder"}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={errors.name}>{(p) => <Input {...p} value={form.name} onChange={set("name")} />}</Field>
        <Field label="Base branch">{(p) => <Input {...p} value={form.baseBranch} onChange={set("baseBranch")} className="font-mono" />}</Field>
      </div>
      <Field label="Absolute path" error={errors.path}>{(p) => <Input {...p} value={form.path} onChange={set("path")} className="font-mono text-[13px]" />}</Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Setup command">{(p) => <Input {...p} value={form.setupCmd} onChange={set("setupCmd")} placeholder="pnpm install" className="font-mono text-[13px]" />}</Field>
        <Field label="Test command">{(p) => <Input {...p} value={form.testCmd} onChange={set("testCmd")} placeholder="pnpm test" className="font-mono text-[13px]" />}</Field>
      </div>
      <Field label="Protected paths" hint="One per line. Path prefixes or globs (e.g. src/payments, **/migrations/**). A PR touching these waits for your approval.">
        {(p) => <Textarea {...p} value={riskText} onChange={(e) => setRiskText(e.target.value)} placeholder={"src/payments\n**/migrations/**\n.env*"} className="min-h-20 font-mono text-[13px]" />}
      </Field>
      <Field label="Folder context" hint="Markdown. Added after org context. The repo's CLAUDE.md is loaded too.">
        {(p) => <Textarea {...p} value={form.contextMd} onChange={set("contextMd")} className="min-h-32 font-mono text-[13px]" />}
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="max-md:min-h-11" disabled={save.isPending}>
          {ws ? "Save" : "Add folder"}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" className="max-md:min-h-11" onClick={onDone}>
            Cancel
          </Button>
        )}
        {ws && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive ml-auto max-md:min-h-11" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden /> Remove
          </Button>
        )}
      </div>
      {ws && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Remove ${ws.name}?`}
          desc="The folder is removed from Zippy. Files on disk are not touched."
          action="Remove folder"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => toast.success("Folder removed") })}
        />
      )}
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
    <div className="grid gap-3">
      {data.length === 0 && !adding && (
        <EmptyState icon={Server} title="No MCP servers yet" desc="MCP servers give agents extra tools, like databases, browsers or issue trackers.">
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden /> Add MCP server
          </Button>
        </EmptyState>
      )}
      {data.map((m) => (
        <McpItem key={m.id} server={m} />
      ))}
      {adding && (
        <Disclosure title="New MCP server" defaultOpen>
          <McpForm onDone={() => setAdding(false)} />
        </Disclosure>
      )}
      {data.length > 0 && !adding && (
        <Button variant="outline" className="justify-self-start max-md:min-h-11" onClick={() => setAdding(true)}>
          <Plus aria-hidden /> Add MCP server
        </Button>
      )}
    </div>
  );
}

function McpItem({ server }: { server: McpServer }) {
  const org = useOrg();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const toggle = useApiMutation((enabled: boolean) => api.patch(`/mcp/${server.id}`, { enabled }), [keys.res(org.id, "mcp")]);
  const scope = server.workspaceId ? (workspaces.find((w) => w.id === server.workspaceId)?.name ?? "One folder") : "All folders";
  return (
    <Disclosure
      title={server.name}
      meta={server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
      badges={<><Chip>{server.transport}</Chip><Chip>{scope}</Chip></>}
      trailing={
        <label className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
          <span className="hidden sm:inline">{server.enabled ? "Enabled" : "Disabled"}</span>
          <Switch aria-label={`Enable ${server.name}`} checked={server.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
        </label>
      }
    >
      <McpForm server={server} />
    </Disclosure>
  );
}

function McpForm({ server, onDone }: { server?: McpServer; onDone?: () => void }) {
  const org = useOrg();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const [form, setForm] = useState<McpServerInput>(server ?? BLANK_MCP);
  const [envText, setEnvText] = useState(envToText(form.env));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const inv = [keys.res(org.id, "mcp")];
  const save = useApiMutation((v: Partial<McpServerInput>) => (server ? api.patch(`/mcp/${server.id}`, v) : api.post(`/orgs/${org.id}/mcp`, v)), inv);
  const remove = useApiMutation(() => api.del(`/mcp/${server!.id}`), inv);
  const ALL = "all";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = mcpServerInput.safeParse({ ...form, env: textToEnv(envText) });
    setErrors(r.success ? {} : fieldErrors(r.error.issues));
    if (!r.success) return;
    // Existing servers toggle `enabled` from the summary row; don't overwrite it with a stale value.
    const { enabled, ...rest } = r.data;
    save.mutate(server ? rest : { ...rest, enabled }, { onSuccess: () => (toast.success(server ? "Server saved" : "Server added"), onDone?.()) });
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate aria-label={server ? `MCP server ${server.name}` : "New MCP server"}>
      <div className="grid gap-4 sm:grid-cols-3">
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
        <div className="grid gap-4 sm:grid-cols-2">
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
        <Button type="submit" size="sm" className="max-md:min-h-11" disabled={save.isPending}>
          {server ? "Save" : "Add server"}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" className="max-md:min-h-11" onClick={onDone}>
            Cancel
          </Button>
        )}
        {!server && (
          <label className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
            Enabled <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
          </label>
        )}
        {server && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive ml-auto max-md:min-h-11" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden /> Remove
          </Button>
        )}
      </div>
      {server && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Remove ${server.name}?`}
          desc="Agents will no longer get this MCP server."
          action="Remove server"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => toast.success("Server removed") })}
        />
      )}
    </form>
  );
}

function Connectors() {
  const { data: system, isLoading } = useSystem();
  const ok = system?.auth.loggedIn;
  const acp = useAcp();
  return (
    <Card title="AI connection" desc="Claude Code runs every agent. It must be logged in on the machine running Zippy.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <span aria-hidden className={`size-2 rounded-full ${ok ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
          {isLoading ? "Checking…" : ok ? `Connected${system.auth.authMethod ? ` (${system.auth.authMethod})` : ""}` : system?.claudePath ? "Not logged in" : "Claude CLI not found"}
        </p>
        {system?.claudePath && <code className="bg-muted text-muted-foreground rounded px-1.5 py-1 text-xs">{system.claudePath}</code>}
      </div>
      <p className="mt-3 flex items-center gap-2 text-[13px]">
        <span aria-hidden className={`size-2 rounded-full ${acp.data?.ok ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
        {acp.isLoading ? "Checking ACP adapter…" : acp.data?.ok ? `ACP adapter running${acp.data.version ? ` (${acp.data.agent} ${acp.data.version})` : ""}` : `ACP adapter failed: ${acp.data?.error ?? "unreachable"}`}
      </p>
      {!isLoading && !ok && (
        <p className="text-muted-foreground mt-3 text-xs">
          Run <code className="bg-muted rounded px-1">claude auth login</code> and start Zippy from that terminal.
        </p>
      )}
    </Card>
  );
}

const WEBHOOK_PATH = "/api/linear/webhook";

function LinearSettings() {
  const org = useOrg();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const disconnect = useApiMutation(() => api.del(`/orgs/${org.id}/linear`), [keys.orgs]);
  const copy = () =>
    navigator.clipboard.writeText(WEBHOOK_PATH).then(() => {
      setCopied(true);
      toast.success("Webhook path copied");
      setTimeout(() => setCopied(false), 2000);
    });
  return (
    <div className="grid gap-5">
      <Card title="Connection" desc="Connects through the Linear MCP server. Agents post to Linear as you, with their name in the comment, ticket status syncs, and every agent gets the Linear MCP server.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <span aria-hidden className={`size-2 rounded-full ${org.linearConnected ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
            {org.linearConnected ? `Connected to ${org.linearWorkspace}` : "Not connected"}
          </p>
          {org.linearConnected ? (
            <Button variant="outline" size="sm" className="max-md:min-h-11" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          ) : (
            <Button asChild size="sm" className="max-md:min-h-11">
              <a href={`/api/linear/connect?orgId=${org.id}`}>Connect Linear</a>
            </Button>
          )}
        </div>
      </Card>
      <Card title="Webhook (optional)" desc="So Linear comments reach agents.">
        <ol className="text-muted-foreground grid list-decimal gap-1.5 pl-4 text-xs">
          <li>Expose the server (e.g. a tunnel).</li>
          <li>
            Add a webhook to your Linear workspace pointing at this path, with Comment events:
            <span className="mt-1.5 flex items-center gap-2">
              <code className="bg-muted text-foreground rounded px-1.5 py-1">{WEBHOOK_PATH}</code>
              <Button type="button" variant="outline" size="sm" className="max-md:min-h-11" onClick={copy} aria-label="Copy webhook path">
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : "Copy"}
              </Button>
            </span>
          </li>
          <li>
            Set <code className="bg-muted rounded px-1">LINEAR_WEBHOOK_SECRET</code> on the server.
          </li>
        </ol>
      </Card>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect Linear?"
        desc="Ticket sync and Linear comments stop until you connect again."
        action="Disconnect"
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => (setConfirming(false), toast.success("Linear disconnected")) })}
      />
    </div>
  );
}
