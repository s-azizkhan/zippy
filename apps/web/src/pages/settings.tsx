import type { IconType } from "@/lib/anim-icon";
import { ProfileFields } from "@/components/profile-fields";
import { MdEditor } from "@/components/md-editor";
import { Bot, Braces, Building2, Database, ChevronRight, Pin, Trash2, X } from "lucide-react";
import { BookTextIcon as BookOpen } from "@/components/ui/book-text";
import { CheckIcon as Check } from "@/components/ui/check";
import { CopyIcon as Copy } from "@/components/ui/copy";
import { DownloadIcon as Download } from "@/components/ui/download";
import { FolderGit2Icon as FolderGit2 } from "@/components/ui/folder-git-2";
import { Link2Icon as Link2 } from "@/components/ui/link-2";
import { PlugZapIcon as Plug } from "@/components/ui/plug-zap";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { RefreshCWIcon as RefreshCw } from "@/components/ui/refresh-cw";
import { SearchIcon as Search } from "@/components/ui/search";
import { ServerIcon as Server } from "@/components/ui/server";
import { WrenchIcon as Wrench } from "@/components/ui/wrench";
import { Collapsible, Tabs as TabsPrimitive } from "radix-ui";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { CACHE_TTLS, EFFORTS, KB_KINDS, KB_LABELS, MODELS, knowledgeInput, mcpServerInput, orgInput, patchOf, workspaceInput, type KnowledgeInput, type McpServer, type McpServerInput, type Workspace, type WorkspaceInput } from "@zippy/shared";
import { Field, fieldErrors, SettingRow } from "@/components/field";
import { DbForm } from "@/components/db-form";
import { FoldersPicker } from "@/components/pickers";
import { OptionSelect } from "@/components/property-menu";
import { ToggleList } from "@/components/toggle-list";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, keys, useApiMutation, useAcp, useClaudeAccounts, useKnowledge, useMcpServers, useSystem, useTools, useUsage, useWorkspaces, type Tools } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { SETTINGS_TABS, type SettingsTab } from "@/lib/settings-tabs";

const ICONS: Record<SettingsTab, IconType> = { org: Building2, database: Database, folders: FolderGit2, knowledge: BookOpen, tools: Wrench, mcp: Server, connectors: Plug, linear: Link2 };
/** One accent per section: tints the hero tile, nav glow and status marks. */
const TINTS: Record<SettingsTab, string> = { org: "#5e6ad2", database: "#26b5ce", folders: "#4cb782", knowledge: "#d4a017", tools: "#a78bfa", mcp: "#e879f9", connectors: "#f97316", linear: "#5e6ad2" };
const GROUPS = [...new Set(SETTINGS_TABS.map((t) => t.group))];
const isTab = (v: string | null): v is SettingsTab => SETTINGS_TABS.some((t) => t.value === v);
const PANES: Record<SettingsTab, { title: string; desc: string }> = {
  org: { title: "Organization", desc: "Identity, spending limits, notifications and shared context for every Zipper." },
  database: { title: "Database", desc: "Where tickets, Zippers and comments are stored." },
  folders: { title: "Working folders", desc: "Local repos Zippers work in. Each ticket gets an isolated worktree of one folder." },
  knowledge: { title: "Knowledge base", desc: "Dos, don'ts, preferences, commands and links. Zippers add to it as they work; the most relevant entries go into each Zipper's prompt." },
  tools: { title: "Zipper tool defaults", desc: "Defaults for every Zipper. Override per Zipper on the Zippers page." },
  mcp: { title: "MCP servers", desc: "Servers given to every Zipper session. Scope one to a folder to limit it." },
  connectors: { title: "Connectors", desc: "Status of the services Zippy connects to." },
  linear: { title: "Linear", desc: "Sync tickets and comments with your Linear workspace." },
};

const PaneCtx = createContext<SettingsTab>("org");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("tab");
  // `?linear=connected` is where the OAuth callback lands.
  const tab: SettingsTab = isTab(q) ? q : params.has("linear") ? "linear" : "org";
  const scroller = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ "--tint": TINTS[tab] } as CSSProperties}>
      <header className="bg-background/80 sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-4 backdrop-blur-md">
        <h1 className="text-[13px] font-semibold">Settings</h1>
        <span aria-hidden className="text-muted-foreground/60">/</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={tab}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            className="text-muted-foreground text-[13px]"
          >
            {PANES[tab].title}
          </motion.span>
        </AnimatePresence>
      </header>
      <div ref={scroller} className="settings-bg flex-1 overflow-y-auto">
        <TabsPrimitive.Root
          value={tab}
          onValueChange={(v) => (setParams({ tab: v }, { replace: true }), scroller.current?.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }))}
          orientation="vertical"
          className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 md:flex-row md:gap-8 md:px-6 md:py-8 lg:gap-12"
        >
          <LayoutGroup id="settings-nav">
            <TabsPrimitive.List aria-label="Settings sections" className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 pb-1 md:sticky md:top-0 md:mx-0 md:w-56 md:flex-col md:gap-0.5 md:self-start md:overflow-visible md:px-0 md:pb-0">
              {GROUPS.map((g) => (
                <div key={g} role="presentation" className="flex gap-1 md:flex-col md:gap-0.5">
                  <span className="text-muted-foreground/80 hidden px-3 pt-5 pb-1.5 text-[11px] font-medium tracking-[0.08em] uppercase first:pt-0 md:block" aria-hidden>
                    {g}
                  </span>
                  {SETTINGS_TABS.filter((t) => t.group === g).map((t) => {
                    const Icon = ICONS[t.value];
                    const active = t.value === tab;
                    return (
                      <TabsPrimitive.Trigger
                        key={t.value}
                        value={t.value}
                        style={{ "--tint": TINTS[t.value] } as CSSProperties}
                        className="group/tab text-muted-foreground hover:text-foreground data-[state=active]:text-foreground focus-visible:ring-ring/60 relative inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-xl px-3 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] md:min-h-9"
                      >
                        {active && (
                          <motion.span
                            layoutId="settings-active-pill"
                            aria-hidden
                            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 36, mass: 0.6 }}
                            className="bg-accent absolute inset-0 rounded-xl shadow-[inset_0_1px_0_rgb(255_255_255/0.5),0_1px_2px_rgb(0_0_0/0.04)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
                          />
                        )}
                        <span aria-hidden className="tint-tile relative grid size-6 shrink-0 place-items-center rounded-md transition-transform duration-300 group-hover/tab:scale-105 group-data-[state=active]/tab:scale-105">
                          <Icon className="size-3.5" />
                        </span>
                        <span className="relative">{t.label}</span>
                      </TabsPrimitive.Trigger>
                    );
                  })}
                </div>
              ))}
            </TabsPrimitive.List>
          </LayoutGroup>
          <div className="min-w-0 flex-1">
            <Pane value="org" active={tab}>
              <OrgSettings active={tab === "org"} />
            </Pane>
            <Pane value="database" active={tab}>
              <Card title="Postgres">
                <DbForm />
              </Card>
            </Pane>
            <Pane value="folders" active={tab}>
              <Folders />
            </Pane>
            <Pane value="knowledge" active={tab}>
              <KnowledgeBase />
            </Pane>
            <Pane value="tools" active={tab}>
              <OrgTools />
            </Pane>
            <Pane value="mcp" active={tab}>
              <McpServers />
            </Pane>
            <Pane value="connectors" active={tab}>
              <div className="stagger grid gap-5">
                <Card title="Tools" desc="Command-line tools Zippers run on this machine.">
                  <SetupTools />
                </Card>
                <Connectors />
                <ClaudeHub />
                <LocalDomain />
                <PhoneAccess />
              </div>
            </Pane>
            <Pane value="linear" active={tab}>
              <LinearSettings />
            </Pane>
          </div>
          <OnThisPage tab={tab} scroller={scroller} />
        </TabsPrimitive.Root>
      </div>
    </div>
  );
}

/** Right rail, wide screens only: every card in the active pane, highlighted as it scrolls into view. */
function OnThisPage({ tab, scroller }: { tab: SettingsTab; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [items, setItems] = useState<{ id: string; label: string }[]>([]);
  const [current, setCurrent] = useState("");
  const reduce = useReducedMotion();
  useEffect(() => {
    const root = scroller.current;
    const pane = root?.querySelector<HTMLElement>(`[data-pane="${tab}"]`);
    const cards = pane ? [...pane.querySelectorAll<HTMLElement>("section[id][data-card-title]")] : [];
    setItems(cards.map((c) => ({ id: c.id, label: c.dataset.cardTitle! })));
    setCurrent(cards[0]?.id ?? "");
    if (!root || cards.length < 3) return;
    const io = new IntersectionObserver(
      (es) => {
        const hit = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setCurrent(hit.target.id);
      },
      { root, rootMargin: "-10% 0px -70% 0px" },
    );
    cards.forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, [tab, scroller]);
  if (items.length < 3) return null;
  return (
    <nav aria-label="On this page" className="hidden w-40 shrink-0 self-start xl:block xl:sticky xl:top-0">
      <p className="text-muted-foreground/80 mb-2 px-3 text-[11px] font-medium tracking-[0.08em] uppercase">On this page</p>
      <ul className="relative grid gap-0.5 border-l">
        {items.map((it) => {
          const on = it.id === current;
          return (
            <li key={it.id} className="relative">
              {on && <motion.span layoutId="settings-rail" aria-hidden transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 36 }} className="absolute inset-y-1 -left-px w-0.5 rounded-full" style={{ background: "var(--tint)" }} />}
              <a
                href={`#${it.id}`}
                aria-current={on ? "true" : undefined}
                onClick={(e) => (e.preventDefault(), document.getElementById(it.id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }), setCurrent(it.id))}
                className={`focus-visible:ring-ring/60 block truncate rounded-md px-3 py-1 text-xs outline-none transition-colors focus-visible:ring-[3px] ${on ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
              >
                {it.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Global shortcut for the desktop capture box. Press keys in the field to record; saves on its own, not with the org form. */
function HotkeyRow() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["system", "hotkey"], queryFn: () => api.get<{ desktop: boolean; hotkey: string | null }>("/system/hotkey") });
  const save = useMutation({
    mutationFn: (hotkey: string | null) => api.post("/system/hotkey", { hotkey }, true),
    onSuccess: (_, hotkey) => (qc.setQueryData(["system", "hotkey"], { desktop: true, hotkey }), toast.success(hotkey ? `Shortcut set to ${pretty(hotkey)}` : "Shortcut disabled")),
    onError: (e: Error) => toast.error(e.message),
  });
  if (!q.data?.desktop) return null;
  const hotkey = q.data.hotkey;
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.key === "Escape" || e.key === "Backspace") return save.mutate(null);
    const mods = [e.metaKey || e.ctrlKey ? "CmdOrCtrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
    const key = /^F\d{1,2}$/.test(e.key) ? e.key : e.key.length === 1 && /[a-z0-9]/i.test(e.key) ? e.key.toUpperCase() : "";
    if (!key || (!mods.length && !key.startsWith("F"))) return; // modifier alone, or a bare letter: wait for the rest
    save.mutate([...mods, key].join("+"));
  };
  return (
    <SettingRow label="Quick capture shortcut" hint={hotkey ? "Press a new combination to change. Backspace disables." : "Press a combination to enable."}>
      {(p) => <Input {...p} readOnly value={hotkey ? pretty(hotkey) : "Off"} onKeyDown={onKeyDown} placeholder="Press keys…" className="w-44 text-center font-mono text-[13px]" />}
    </SettingRow>
  );
}

const MAC = navigator.platform.startsWith("Mac");
const pretty = (hk: string) => hk.replace("CmdOrCtrl", MAC ? "⌘" : "Ctrl").replace("Shift", "⇧").replace("Alt", MAC ? "⌥" : "Alt").replaceAll("+", MAC ? "" : "+");

/**
 * Panes stay mounted so unsaved edits survive tab switches. Going display:none → shown restarts the CSS
 * `rise` animation on the hero and every `.stagger` child, so the entrance replays on each visit for free.
 */
function Pane({ value, children }: { value: SettingsTab; active: SettingsTab; children: ReactNode }) {
  const Icon = ICONS[value];
  const { title, desc } = PANES[value];
  return (
    <PaneCtx.Provider value={value}>
      <TabsPrimitive.Content value={value} forceMount data-pane={value} className="stagger grid gap-5 outline-none data-[state=inactive]:hidden" style={{ "--tint": TINTS[value] } as CSSProperties}>
        <div className="rise flex items-start gap-4">
          <span aria-hidden className="tint-tile hero-tile grid size-12 shrink-0 place-items-center rounded-2xl">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h2 className="text-xl font-semibold tracking-tight text-balance">{title}</h2>
            <p className="text-muted-foreground mt-1 max-w-prose text-[13px] leading-relaxed text-pretty">{desc}</p>
          </div>
        </div>
        {children}
      </TabsPrimitive.Content>
    </PaneCtx.Provider>
  );
}

function Card({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  const pane = useContext(PaneCtx);
  return (
    <section id={`${pane}-${slug(title)}`} data-card-title={title} aria-labelledby={`${pane}-${slug(title)}-h`} className="settings-card rise bg-card grid scroll-mt-20 gap-4 rounded-2xl border p-5 sm:p-6">
      <div>
        <h3 id={`${pane}-${slug(title)}-h`} className="text-sm font-semibold tracking-tight">{title}</h3>
        {desc && <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ icon: Icon, title, desc, children }: { icon: IconType; title: string; desc: string; children?: ReactNode }) {
  return (
    <div className="empty-state rise grid justify-items-center gap-1 rounded-2xl border border-dashed px-6 py-12 text-center">
      <span aria-hidden className="tint-tile float mb-3 grid size-12 place-items-center rounded-2xl">
        <Icon className="size-5" />
      </span>
      <p className="text-sm font-semibold tracking-tight">{title}</p>
      <p className="text-muted-foreground max-w-sm text-xs leading-relaxed text-pretty">{desc}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** Connection status: label + dot, pinging softly while connected. Announces changes to screen readers. */
function Status({ ok, loading, children }: { ok: boolean; loading?: boolean; children: ReactNode }) {
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2.5 text-[13px] font-medium">
      <span aria-hidden className="relative grid size-2.5 place-items-center">
        {ok && !loading && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/50 [animation-duration:2.4s]" />}
        <span className={`relative size-2 rounded-full transition-colors duration-500 ${loading ? "bg-muted-foreground/40 animate-pulse" : ok ? "bg-emerald-500 shadow-[0_0_8px_rgb(16_185_129/0.6)]" : "bg-muted-foreground/50"}`} />
      </span>
      {children}
    </p>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, desc, action, onConfirm, pending }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; desc: string; action: string; onConfirm: () => void; pending?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <X aria-hidden /> Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            <Trash2 aria-hidden /> {action}
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
    <Collapsible.Root open={open} onOpenChange={setOpen} className="settings-card rise bg-card min-w-0 rounded-2xl border data-[state=open]:shadow-md">
      <div className="flex items-center gap-3 pr-4">
        <Collapsible.Trigger className="group focus-visible:ring-ring/60 flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-[3px]">
          <ChevronRight aria-hidden className="text-muted-foreground size-4 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-data-[state=open]:rotate-90" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{title || "Untitled"}</span>
            {meta && <span className="text-muted-foreground block truncate font-mono text-xs">{meta}</span>}
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 sm:flex">{badges}</span>
        </Collapsible.Trigger>
        {trailing}
      </div>
      <Collapsible.Content forceMount className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[state=closed]:grid-rows-[0fr] data-[state=open]:grid-rows-[1fr]">
        <div inert={!open} className="min-h-0 overflow-hidden">
          <div className={`border-t p-4 transition-[opacity,translate] duration-300 sm:p-5 ${open ? "opacity-100" : "translate-y-1 opacity-0"}`}>{children}</div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

const Chip = ({ children }: { children: ReactNode }) => <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-foreground/[0.04] ring-inset">{children}</span>;

function OrgTools() {
  const org = useOrg();
  const save = useApiMutation((toggles: Record<string, boolean>) => api.patch(`/orgs/${org.id}`, { toggles }), [keys.orgs]);
  return <ToggleList toggles={org.toggles} onChange={(t) => save.mutate(t)} />;
}

function OrgSettings({ active }: { active: boolean }) {
  const org = useOrg();
  const base = { name: org.name, key: org.key, contextMd: org.contextMd, defaultModel: org.defaultModel, defaultEffort: org.defaultEffort, cacheTtl: org.cacheTtl, idleMinutes: org.idleMinutes, maxLive: org.maxLive, budgetUsd: org.budgetUsd ?? null, slackWebhookUrl: org.slackWebhookUrl.trim(), notifyDesktop: org.notifyDesktop, useActiveBranch: org.useActiveBranch, worktreeDir: org.worktreeDir, profile: org.profile };
  const baseKey = JSON.stringify(base);
  const [form, setForm] = useState(base);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(form) !== baseKey;
  const save = useApiMutation((v: typeof form) => api.patch(`/orgs/${org.id}`, patchOf(orgInput).parse(v)), [keys.orgs]);
  const pickWorktreeDir = async () => {
    const { path } = await api.post<{ path: string | null }>("/system/pick-folder");
    if (path) setForm((f) => ({ ...f, worktreeDir: path }));
  };

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
    <form onSubmit={(e) => (e.preventDefault(), submit())} noValidate className="stagger grid gap-5">
      <Card title="You" desc="Zippers commit as you and know who they work for.">
        <ProfileFields profile={form.profile} onChange={(profile) => setForm({ ...form, profile })} />
      </Card>
      <Card title="Identity">
        <Field label="Name" error={errors.name}>
          {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field label="Ticket prefix" hint="2-6 uppercase letters. Used in new ticket IDs and links, e.g. COM-768. Existing tickets keep their ID." error={errors.key}>
          {(p) => <Input {...p} value={form.key} maxLength={6} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} className="w-32 font-mono" />}
        </Field>
      </Card>
      <Card title="Zipper defaults" desc="Used by Zippers whose model is set to default. Empty picks follow your Claude Code setting.">
        {([["Model", "defaultModel", MODELS], ["Thinking level", "defaultEffort", EFFORTS]] as const).map(([label, k, opts]) => (
          <Field key={k} label={label}>
            {(p) => (
              <OptionSelect id={p.id} label={label} value={form[k]} onChange={(v) => setForm({ ...form, [k]: v })} options={(opts.includes(form[k]) ? opts : [...opts, form[k]]).map((m) => ({ value: m, label: m }))} />
            )}
          </Field>
        ))}
        <Field label="Prompt cache" hint="1h keeps context cheap when Zippers are woken more than 5 minutes apart, but cache writes cost more.">
          {(p) => <OptionSelect id={p.id} label="Prompt cache" value={form.cacheTtl} onChange={(v) => setForm({ ...form, cacheTtl: v as "5m" | "1h" })} options={CACHE_TTLS.map((m) => ({ value: m, label: m }))} />}
        </Field>
      </Card>
      <Card title="Resources" desc="Each running Zipper is a separate process (~300-500 MB). Lower these on small machines; nothing is lost, idle Zippers resume on their next prompt.">
        {([["Stop idle Zippers after (minutes)", "idleMinutes", 1, "Applies to Zippers started after saving."], ["Max running Zippers", "maxLive", 0, "0 = no limit. At the limit the oldest idle Zipper is stopped; if all are busy, new work waits."]] as const).map(([label, k, min, hint]) => (
          <Field key={k} label={label} hint={hint} error={errors[k]}>
            {(p) => <Input {...p} type="number" min={min} step={1} inputMode="numeric" value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} className="w-32" />}
          </Field>
        ))}
      </Card>
      <Card title="Budget" desc="Zippers stop and ask you when a ticket's total spend reaches this limit.">
        <Field label="Zipper budget per ticket (USD)" hint="Empty = no limit." error={errors.budgetUsd}>
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
      <Card title="Git" desc="How Zippers get a checkout of each folder.">
        <SettingRow label="Work on the active branch" hint="No worktree or new branch: Zippers edit the folder in place on its checked-out branch. Zippers on different tickets share that checkout, so run them one at a time.">
          {(p) => <Switch {...p} checked={form.useActiveBranch} onCheckedChange={(useActiveBranch) => setForm({ ...form, useActiveBranch })} />}
        </SettingRow>
        {!form.useActiveBranch && (
          <Field label="Worktree location" hint={form.worktreeDir ? `Worktrees go in ${form.worktreeDir}/<folder>/<ticket>.` : "Worktrees go in each folder's .zippy/worktrees/<ticket>, hidden from its git status."}>
            {(p) => (
              <div className="flex gap-2">
                <OptionSelect
                  id={p.id}
                  label="Worktree location"
                  value={form.worktreeDir ? "custom" : "project"}
                  onChange={(v) => (v === "project" ? setForm((f) => ({ ...f, worktreeDir: "" })) : pickWorktreeDir())}
                  options={[{ value: "project", label: "Inside the project (.zippy/worktrees)" }, { value: "custom", label: "Custom folder…" }]}
                  className="w-72"
                />
                {form.worktreeDir && (
                  <Button type="button" variant="outline" size="sm" className="min-w-0 max-md:min-h-11" onClick={pickWorktreeDir}>
                    <FolderGit2 aria-hidden /> <span className="truncate font-mono text-[13px]">{form.worktreeDir}</span>
                  </Button>
                )}
              </div>
            )}
          </Field>
        )}
      </Card>
      <Card title="Notifications" desc="Sent when a ticket needs input, is ready for review, or is blocked.">
        <SettingRow label="Desktop notifications" hint="macOS notification on those events.">
          {(p) => (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="xs" onClick={() => api.post("/system/test-notification", {}, true).then(() => toast.success("Test sent. Switch to another app if no banner shows."))}>
                Send test
              </Button>
              <Switch {...p} checked={form.notifyDesktop} onCheckedChange={(notifyDesktop) => setForm({ ...form, notifyDesktop })} />
            </div>
          )}
        </SettingRow>
        <HotkeyRow />
        <Field label="Slack webhook" hint="Incoming webhook URL. Empty = off." error={errors.slackWebhookUrl}>
          {(p) => <Input {...p} value={form.slackWebhookUrl} onChange={(e) => setForm({ ...form, slackWebhookUrl: e.target.value.trim() })} placeholder="https://hooks.slack.com/services/…" className="font-mono text-[13px]" />}
        </Field>
      </Card>
      <Card title="Context" desc="Markdown. Every Zipper gets this: product, conventions, people, rules.">
        <Field label="Organization context" error={errors.contextMd}>
          {(p) => <MdEditor id={p.id} value={form.contextMd} onChange={(contextMd) => setForm((f) => ({ ...f, contextMd }))} className="min-h-72" />}
        </Field>
      </Card>
      <SaveBar show={dirty} pending={save.isPending} onDiscard={() => (setForm(base), setErrors({}))} />
    </form>
  );
}

/** Floating glass pill at the bottom of a dirty form. Springs in, keeps the ⌘S hint, stays reachable on touch. */
function SaveBar({ show, pending, onDiscard }: { show: boolean; pending: boolean; onDiscard: () => void }) {
  const reduce = useReducedMotion();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
      <AnimatePresence>
        {show && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
            className="liquid pointer-events-auto flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5"
          >
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <span aria-hidden className="relative grid size-2.5 place-items-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-amber-500/50 [animation-duration:1.8s]" />
                <span className="relative size-2 rounded-full bg-amber-500" />
              </span>
              {pending ? "Saving…" : "Unsaved changes"}
            </span>
            <Button type="button" variant="ghost" size="sm" className="max-md:min-h-11" onClick={onDiscard} disabled={pending}>
              Discard
            </Button>
            <Button type="submit" size="sm" className="max-md:min-h-11" disabled={pending}>
              {pending ? "Saving…" : "Save"}
              <kbd aria-hidden className="bg-primary-foreground/20 hidden rounded px-1 font-mono text-[10px] sm:inline">
                ⌘S
              </kbd>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const BLANK_WS: WorkspaceInput = { name: "", path: "", baseBranch: "main", setupCmd: "", testCmd: "", contextMd: "", riskPaths: [] };

function Folders() {
  const org = useOrg();
  const { data = [] } = useWorkspaces(org.id);
  const [adding, setAdding] = useState(false);
  return (
    <div className="stagger grid gap-3">
      {data.length === 0 && !adding && (
        <EmptyState icon={FolderGit2} title="No working folders yet" desc="Add a local git repo so Zippers have somewhere to work.">
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

export function FolderForm({ ws, onDone }: { ws?: Workspace; onDone?: () => void }) {
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
      <Field label="Absolute path" error={errors.path}>
        {(p) => (
          <div className="flex gap-2">
            <Input {...p} value={form.path} onChange={set("path")} className="font-mono text-[13px]" />
            <Button type="button" variant="outline" className="max-md:min-h-11" onClick={async () => { const { path } = await api.post<{ path: string | null }>("/system/pick-folder"); if (path) setForm((f) => ({ ...f, path, name: f.name || path.split("/").pop()! })); }}>
              <FolderGit2 aria-hidden /> Browse
            </Button>
          </div>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Setup command">{(p) => <Input {...p} value={form.setupCmd} onChange={set("setupCmd")} placeholder="pnpm install" className="font-mono text-[13px]" />}</Field>
        <Field label="Test command">{(p) => <Input {...p} value={form.testCmd} onChange={set("testCmd")} placeholder="pnpm test" className="font-mono text-[13px]" />}</Field>
      </div>
      <Field label="Protected paths" hint="One per line. Path prefixes or globs (e.g. src/payments, **/migrations/**). A PR touching these waits for your approval.">
        {(p) => <Textarea {...p} value={riskText} onChange={(e) => setRiskText(e.target.value)} placeholder={"src/payments\n**/migrations/**\n.env*"} className="min-h-20 font-mono text-[13px]" />}
      </Field>
      <Field label="Folder context" hint="Markdown. Added after org context. The repo's CLAUDE.md is loaded too.">
        {(p) => <MdEditor id={p.id} value={form.contextMd} onChange={(contextMd) => setForm((f) => ({ ...f, contextMd }))} className="min-h-28" />}
      </Field>
      <div className="bg-popover sticky -bottom-4 z-10 -mx-4 -mb-4 flex gap-2 border-t px-4 py-3">
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

const BLANK_MCP: McpServerInput = { name: "", workspaceIds: [], transport: "stdio", command: "", args: [], url: "", env: {}, enabled: true };
const envToText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
const textToEnv = (t: string) => Object.fromEntries(t.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const toMcpJson = (list: McpServer[]) =>
  JSON.stringify({ mcpServers: Object.fromEntries(list.map((m) => [m.name, m.transport === "stdio" ? { command: m.command, args: m.args, env: m.env } : { url: m.url, headers: m.env }])) }, null, 2);

/** .mcp.json entry -> input. Keeps scope/enabled of an existing server. */
function parseMcp(name: string, c: any, cur?: McpServer) {
  const r = mcpServerInput.safeParse({
    name,
    workspaceIds: cur?.workspaceIds ?? [],
    transport: c.url ? "http" : "stdio",
    command: c.command,
    args: c.args,
    url: c.url,
    env: c.env ?? c.headers,
    enabled: cur?.enabled ?? true,
  });
  if (!r.success) throw new Error(`${name}: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  return r.data;
}

function McpJsonEditor({ servers, onDone }: { servers: McpServer[]; onDone: () => void }) {
  const org = useOrg();
  const [text, setText] = useState(() => toMcpJson(servers));
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<McpServerInput[] | null>(null);
  const save = useApiMutation(
    (list: McpServerInput[]) =>
      Promise.all([
        ...list.map((v) => {
          const cur = servers.find((s) => s.name === v.name);
          return cur ? api.patch(`/mcp/${cur.id}`, { ...v, enabled: undefined }) : api.post(`/orgs/${org.id}/mcp`, v);
        }),
        ...servers.filter((s) => !list.some((v) => v.name === s.name)).map((s) => api.del(`/mcp/${s.id}`)),
      ]),
    [keys.res(org.id, "mcp")],
  );

  async function importFrom() {
    try {
      const found = await api.get<Record<string, unknown>>("/catalog/mcp");
      const cur = JSON.parse(text || "{}").mcpServers ?? {};
      const fresh = Object.keys(found).filter((n) => !(n in cur));
      setText(JSON.stringify({ mcpServers: { ...cur, ...Object.fromEntries(fresh.map((n) => [n, found[n]])) } }, null, 2));
      setError("");
      toast.success(fresh.length ? `Imported ${fresh.length} server(s). Review, then save.` : "Nothing new to import");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function apply() {
    const list: McpServerInput[] = [];
    try {
      const map = JSON.parse(text).mcpServers;
      if (!map || typeof map !== "object") throw new Error('Expected {"mcpServers": {…}}');
      for (const [name, c] of Object.entries<any>(map)) list.push(parseMcp(name, c, servers.find((s) => s.name === name)));
    } catch (e) {
      return setError((e as Error).message);
    }
    setError("");
    if (servers.some((s) => !list.some((v) => v.name === s.name))) return setConfirm(list);
    commit(list);
  }

  const commit = (list: McpServerInput[]) => save.mutate(list, { onSuccess: () => (toast.success("MCP servers saved"), onDone()) });
  const removed = confirm ? servers.filter((s) => !confirm.some((v) => v.name === s.name)).map((s) => s.name) : [];

  return (
    <div className="stagger grid gap-3">
      <Field label="MCP JSON" hint="Same format as .mcp.json. Existing names update, new names are added, missing names are removed." error={error}>
        {(p) => <Textarea {...p} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="min-h-72 font-mono text-[13px]" />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="max-md:min-h-11" disabled={save.isPending} onClick={apply}>
          Save JSON
        </Button>
        <Button size="sm" variant="outline" className="max-md:min-h-11" onClick={importFrom}>
          Import from Claude Code &amp; Desktop
        </Button>
        <Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Remove ${removed.length} server(s)?`}
        desc={`Not in the JSON: ${removed.join(", ")}. Zippers will no longer get them.`}
        action="Save and remove"
        pending={save.isPending}
        onConfirm={() => commit(confirm!)}
      />
    </div>
  );
}

function McpServers() {
  const org = useOrg();
  const { data = [] } = useMcpServers(org.id);
  const [adding, setAdding] = useState(false);
  const [json, setJson] = useState(false);
  const add = useApiMutation((list: McpServerInput[]) => Promise.all(list.map((v) => api.post(`/orgs/${org.id}/mcp`, v))), [keys.res(org.id, "mcp")]);

  async function importFrom() {
    try {
      const found = await api.get<Record<string, unknown>>("/catalog/mcp");
      const fresh = Object.entries(found).filter(([n]) => !data.some((s) => s.name === n));
      if (!fresh.length) return void toast.success("Nothing new to import");
      add.mutate(fresh.map(([n, c]) => parseMcp(n, c)), { onSuccess: () => toast.success(`Imported ${fresh.length} server(s)`) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (json) return <McpJsonEditor servers={data} onDone={() => setJson(false)} />;
  const toolbar = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button variant={data.length ? "outline" : "default"} className="max-md:min-h-11" onClick={() => setAdding(true)}>
        <Plus aria-hidden /> Add MCP server
      </Button>
      <Button variant="outline" className="max-md:min-h-11" disabled={add.isPending} onClick={importFrom}>
        <Download aria-hidden /> Import from Claude Code &amp; Desktop
      </Button>
      <Button variant="ghost" className="max-md:min-h-11" onClick={() => setJson(true)}>
        <Braces aria-hidden /> Edit as JSON
      </Button>
    </div>
  );
  return (
    <div className="stagger grid gap-3">
      {data.length === 0 && !adding && (
        <EmptyState icon={Server} title="No MCP servers yet" desc="MCP servers give Zippers extra tools, like databases, browsers or issue trackers.">
          {toolbar}
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
      {data.length > 0 && !adding && toolbar}
    </div>
  );
}

function McpItem({ server }: { server: McpServer }) {
  const org = useOrg();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const toggle = useApiMutation((enabled: boolean) => api.patch(`/mcp/${server.id}`, { enabled }), [keys.res(org.id, "mcp")]);
  const names = server.workspaceIds.map((id) => workspaces.find((w) => w.id === id)?.name).filter(Boolean);
  const scope = names.length ? names.join(", ") : "All folders";
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
  const [form, setForm] = useState<McpServerInput>(server ?? BLANK_MCP);
  const [envText, setEnvText] = useState(envToText(form.env));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const inv = [keys.res(org.id, "mcp")];
  const save = useApiMutation((v: Partial<McpServerInput>) => (server ? api.patch(`/mcp/${server.id}`, v) : api.post(`/orgs/${org.id}/mcp`, v)), inv);
  const remove = useApiMutation(() => api.del(`/mcp/${server!.id}`), inv);

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
            <OptionSelect id={p.id} label="Transport" value={form.transport} onChange={(v) => setForm({ ...form, transport: v as "stdio" | "http" })} options={[{ value: "stdio", label: "stdio" }, { value: "http", label: "http" }]} />
          )}
        </Field>
        <Field label="Folders" hint="None = all folders.">{() => <FoldersPicker orgId={org.id} value={form.workspaceIds} onChange={(workspaceIds) => setForm({ ...form, workspaceIds })} />}</Field>
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
          desc="Zippers will no longer get this MCP server."
          action="Remove server"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => toast.success("Server removed") })}
        />
      )}
    </form>
  );
}

function Connectors() {
  const { data: system, isLoading, isFetching, refetch } = useSystem();
  const ok = system?.auth.loggedIn;
  const acp = useAcp();
  const recheck = () => Promise.all([refetch(), acp.refetch()]).then(([s]) => s.data && toast[s.data.auth.loggedIn ? "success" : "error"](s.data.auth.loggedIn ? "Claude connected" : "Still not logged in"));
  return (
    <Card title="AI connection" desc="Claude Code runs every Zipper, as the default account below or this machine's own login.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Status ok={!!ok} loading={isLoading}>
          {isLoading ? "Checking…" : ok ? "Connected" : system?.claudePath ? (system.auth.error ? `Claude check failed: ${system.auth.error}` : "Not logged in") : "Claude CLI not found"}
        </Status>
        <div className="flex items-center gap-2">
          {system?.claudePath && <code className="bg-muted text-muted-foreground rounded-md px-1.5 py-1 text-xs">{system.claudePath}</code>}
          <Button variant="outline" size="sm" className="max-md:min-h-11" disabled={isFetching} onClick={recheck}>
            <RefreshCw aria-hidden className={isFetching ? "animate-spin" : undefined} /> Recheck
          </Button>
        </div>
      </div>
      <Status ok={!!acp.data?.ok} loading={acp.isLoading}>
        {acp.isLoading ? "Checking ACP adapter…" : acp.data?.ok ? `ACP adapter running${acp.data.version ? ` (${acp.data.agent} ${acp.data.version})` : ""}` : `ACP adapter failed: ${acp.data?.error ?? "unreachable"}`}
      </Status>
      {!isLoading && !ok && (
        <p className="text-muted-foreground mt-3 text-xs">
          Add an account below, or run <code className="bg-muted rounded px-1">claude auth login</code> in a terminal and Recheck.
        </p>
      )}
      <ClaudeAccounts />
    </Card>
  );
}

const TOOL_ROWS = [
  { id: "claude", name: "Claude Code", why: "Runs every Zipper." },
  { id: "git", name: "Git", why: "Worktrees, commits and diffs." },
  { id: "gh", name: "GitHub CLI", why: "Optional. Opens PRs, follows CI and reviews." },
] as const;

/** claude, git and gh: installed and signed in, with one-click installs. `signIn` shows Claude sign-in inline (onboarding has no AI connection card). */
export function SetupTools({ signIn = false }: { signIn?: boolean }) {
  const qc = useQueryClient();
  const { data, isFetching, refetch } = useTools();
  const run = useApiMutation((job: keyof Tools["jobs"]) => api.post(`/system/tools/${job}`, {}, true), [["system", "tools"]]);
  const running = Object.values(data?.jobs ?? {}).some((j) => j?.running);
  const [confirmClean, setConfirmClean] = useState(false);
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) qc.invalidateQueries({ queryKey: ["system"] }); // banner + AI connection follow a finished install
    was.current = running;
  }, [running, qc]);
  return (
    <div className="grid gap-3">
      <ul className="grid gap-3">
        {TOOL_ROWS.map((r) => {
          const t = data?.[r.id];
          const job = data?.jobs[r.id];
          const login = r.id === "gh" ? data?.jobs["gh-login"] : undefined;
          const ok = !!t?.path && t.signedIn !== false;
          return (
            <li key={r.id} className="grid gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-0.5">
                  <Status ok={ok} loading={!data}>
                    {r.name}
                    <span className="text-muted-foreground font-normal">
                      {!t ? "Checking…" : !t.path ? "Not installed" : t.signedIn === false ? "Not signed in" : (t.version ?? "Installed")}
                    </span>
                  </Status>
                  <p className="text-muted-foreground pl-5 text-xs">{r.why}</p>
                </div>
                {t && !t.path && (
                  <Button size="sm" variant="outline" className="max-md:min-h-11" disabled={job?.running || run.isPending} onClick={() => run.mutate(r.id, { onError: (e) => toast.error(e.message) })}>
                    {job?.running ? "Installing…" : "Install"}
                  </Button>
                )}
                {r.id === "gh" && t?.path && t.signedIn === false && (
                  <Button size="sm" variant="outline" className="max-md:min-h-11" disabled={login?.running || run.isPending} onClick={() => run.mutate("gh-login", { onError: (e) => toast.error(e.message) })}>
                    {login?.running ? "Waiting for GitHub…" : "Sign in to GitHub"}
                  </Button>
                )}
              </div>
              {r.id === "git" && job && !t?.path && !job.error && <p className="text-xs">Finish Apple's Command Line Tools installer. This updates by itself when it's done.</p>}
              {login?.running && login.code && (
                <p className="text-xs">
                  Enter <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-sm font-semibold select-all">{login.code}</code> at{" "}
                  <a href={login.url ?? "https://github.com/login/device"} target="_blank" rel="noreferrer" className="text-primary underline">github.com/login/device</a>
                </p>
              )}
              {[job, login].map((j, i) => j?.error && <p key={i} role="alert" className="text-destructive text-xs">{j.error}</p>)}
              {r.id === "claude" && t?.path && t.signedIn === false && (signIn ? <AddAccount /> : <p className="text-muted-foreground text-xs">Sign in under AI connection below.</p>)}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="max-md:min-h-11" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw aria-hidden className={isFetching ? "animate-spin" : undefined} /> Recheck
        </Button>
        {!!data?.installedByZippy.length && (
          <Button variant="ghost" size="sm" className="text-destructive max-md:min-h-11" disabled={running} onClick={() => setConfirmClean(true)}>
            <Trash2 aria-hidden /> {data.jobs.clean?.running ? "Removing…" : "Remove what Zippy installed"}
          </Button>
        )}
      </div>
      {data?.jobs.clean?.error && <p role="alert" className="text-destructive text-xs">{data.jobs.clean.error}</p>}
      <ConfirmDialog
        open={confirmClean}
        onOpenChange={setConfirmClean}
        title="Remove what Zippy installed?"
        desc={`Removes: ${data?.installedByZippy.join("; ")}. Tools you installed yourself (Homebrew, Apple's Command Line Tools) stay. Zippers can't run until they're installed again.`}
        action="Remove"
        pending={run.isPending}
        onConfirm={() => run.mutate("clean", { onSuccess: () => setConfirmClean(false), onError: (e) => toast.error(e.message) })}
      />
    </div>
  );
}

const METHOD_LABEL = { oauth: "Claude sign-in", api_key: "API key" } as const;

/** Claude credentials Zippers run as: the machine login, plus any number of OAuth or API-key accounts. One is the default. */
function ClaudeAccounts() {
  const { data: accounts = [] } = useClaudeAccounts();
  const { data: usage } = useUsage();
  const refresh = [["system"]];
  const setDefault = useApiMutation((id: string | null) => api.put("/system/claude-accounts/default", { id }), refresh);
  const remove = useApiMutation((id: string) => api.del(`/system/claude-accounts/${id}`), refresh);
  const test = useApiMutation((id: string) => api.post<{ loggedIn: boolean; error?: string }>(`/system/claude-accounts/${id}/test`, {}, true));
  const hasDefault = accounts.some((a) => a.isDefault);
  const rowCls = "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px]";
  return (
    <div className="mt-4 grid gap-2 border-t pt-4">
      <h4 className="text-sm font-medium">Accounts</h4>
      <p className="text-muted-foreground text-xs">New Zipper sessions use the default. Running ones keep the account they started with.</p>
      <div className={rowCls}>
        <span>
          This machine's login {!hasDefault && <span className="text-emerald-600 text-xs font-medium dark:text-emerald-400">default</span>}
        </span>
        {hasDefault && (
          <Button variant="outline" size="sm" disabled={setDefault.isPending} onClick={() => setDefault.mutate(null)}>
            Make default
          </Button>
        )}
      </div>
      {accounts.map((a) => (
        <div key={a.id} className={rowCls}>
          <span className="min-w-0">
            <RenameLabel account={a} /> <span className="text-muted-foreground text-xs">{METHOD_LABEL[a.method]} {a.hint}</span>{" "}
            {a.isDefault && <span className="text-emerald-600 text-xs font-medium dark:text-emerald-400">default</span>}
            {usage?.[a.id] && (
              <span className="text-muted-foreground mt-0.5 block font-mono text-[11px] tabular-nums">
                5h {Math.round(usage[a.id]!.five_hour?.utilization ?? 0)}% · week {Math.round(usage[a.id]!.seven_day?.utilization ?? 0)}%
              </span>
            )}
          </span>
          <span className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={test.isPending}
              onClick={() => test.mutate(a.id, { onSuccess: (r) => (r.loggedIn ? toast.success(`${a.label} works`) : toast.error(r.error ?? `${a.label} is not authorized`)) })}
            >
              Test
            </Button>
            {!a.isDefault && (
              <Button variant="outline" size="sm" disabled={setDefault.isPending} onClick={() => setDefault.mutate(a.id)}>
                Make default
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(a.id, { onSuccess: () => toast.success("Account removed") })}>
              Remove
            </Button>
          </span>
        </div>
      ))}
      <AddAccount />
    </div>
  );
}

/** Account name; click to edit, Enter saves, Escape cancels. */
function RenameLabel({ account }: { account: { id: string; label: string } }) {
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useApiMutation((label: string) => api.patch(`/system/claude-accounts/${account.id}`, { label }, true), [["system"]]);
  if (draft === null)
    return (
      <button type="button" className="hover:underline" title="Rename" onClick={() => setDraft(account.label)}>
        {account.label}
      </button>
    );
  const save = () => {
    const label = draft.trim();
    if (label && label !== account.label) rename.mutate(label, { onError: (e) => toast.error(e.message) });
    setDraft(null);
  };
  return (
    <Input
      autoFocus
      aria-label="Account name"
      value={draft}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && setDraft(null))}
      className="inline-block h-7 w-40"
    />
  );
}

type Login = { status: "starting" | "awaiting_code" | "saving" | "done" | "error"; url?: string; error?: string };

function AddAccount() {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [loginId, setLoginId] = useState<string | null>(null);
  const done = () => (qc.invalidateQueries({ queryKey: ["system"] }), setLabel(""), setKey(""), setCode(""), setLoginId(null));
  const addKey = useApiMutation((v: { method: "api_key"; secret: string }) => api.post("/system/claude-accounts", { label, ...v }, true), []);
  const start = useApiMutation(() => api.post<{ id: string }>("/system/claude-accounts/login", { label }, true));
  const sendCode = useApiMutation(() => api.post(`/system/claude-accounts/login/${loginId}/code`, { code }, true));
  const login = useQuery({
    queryKey: ["system", "claude-login", loginId],
    queryFn: () => api.get<Login>(`/system/claude-accounts/login/${loginId}`),
    enabled: !!loginId,
    refetchInterval: (q) => (q.state.data?.status === "done" || q.state.data?.status === "error" ? false : 1000),
  });
  const st = login.data?.status;
  useEffect(() => {
    if (st === "done") (toast.success("Claude account added"), done());
  }, [st]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = () => (loginId && api.del(`/system/claude-accounts/login/${loginId}`), setLoginId(null), setCode(""));
  const busy = !!loginId && st !== "error";
  const fail = (e: Error) => toast.error(e.message);
  return (
    <form className="grid gap-2 rounded-lg border border-dashed p-3" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="claude-acct-label" className="text-sm font-medium">Add account</label>
      <Input id="claude-acct-label" placeholder="Label, e.g. Work Max" value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} maxLength={60} />
      {!busy && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input type="password" autoComplete="off" aria-label="Anthropic API key" placeholder="API key  sk-ant-api…" value={key} onChange={(e) => setKey(e.target.value)} className="min-w-0 flex-1" />
            <Button type="submit" size="sm" disabled={!label.trim() || !key.trim() || addKey.isPending} onClick={() => addKey.mutate({ method: "api_key", secret: key }, { onSuccess: () => (toast.success("API key added"), done()), onError: fail })}>
              Save key
            </Button>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={!label.trim() || start.isPending} onClick={() => start.mutate(undefined, { onSuccess: (r) => setLoginId(r.id), onError: fail })}>
            Sign in with Claude
          </Button>
          {st === "error" && login.data?.error && <p className="text-destructive text-xs">{login.data.error}</p>}
        </>
      )}
      {busy && (
        <div className="grid gap-2 text-[13px]">
          {st === "awaiting_code" && login.data?.url ? (
            <>
              <p>
                <a href={login.data.url} target="_blank" rel="noreferrer" className="text-primary underline">Open Claude sign-in</a>, authorize, then paste the code it shows:
              </p>
              <div className="flex gap-2">
                <Input autoComplete="off" aria-label="Authorization code" placeholder="Code from claude.ai" value={code} onChange={(e) => setCode(e.target.value)} className="min-w-0 flex-1" />
                <Button type="submit" size="sm" disabled={!code.trim() || sendCode.isPending} onClick={() => sendCode.mutate(undefined, { onError: fail })}>
                  Submit
                </Button>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">{st === "saving" ? "Saving…" : "Starting sign-in…"}</p>
          )}
          <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={cancel}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}

type HubTool = { name: string; group: string; risk: "read" | "write" | "danger"; summary: string; enabled: boolean };
type Hub = { name: string; url: string; enabled: boolean; token: string | null; command: string | null; registered: boolean; current: boolean; desktop: boolean | null; tools: HubTool[] };
const RISK: Record<HubTool["risk"], { label: string; cls: string }> = {
  read: { label: "read", cls: "text-muted-foreground bg-muted" },
  write: { label: "writes", cls: "text-amber-700 bg-amber-500/10 dark:text-amber-400" },
  danger: { label: "irreversible", cls: "text-red-700 bg-red-500/10 dark:text-red-400" },
};

/** Card header switch: on/off for the whole feature. */
function EnableSwitch({ id, checked, disabled, onChange }: { id: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium max-md:min-h-11">
      {checked ? "Enabled" : "Disabled"}
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

/** Zippy Hub: tickets, agents and terminals as an MCP server in Claude Code (user scope), for Claude sessions outside Zippy. */
function ClaudeHub() {
  const qc = useQueryClient();
  const { data: hub, isLoading } = useQuery({ queryKey: ["system", "hub"], queryFn: () => api.get<Hub>("/system/hub") });
  const act = useMutation({
    mutationFn: ({ op, body = {} }: { op: "register" | "rotate" | "unregister" | "enabled" | "revoke"; body?: object }) => api.post<Hub>(`/system/hub/${op}`, body, true),
    onSuccess: (h, { op }) => {
      qc.setQueryData(["system", "hub"], h);
      toast.success({ register: h.desktop !== null ? "Registered in Claude Code and Claude Desktop (restart Desktop to load it)" : "Registered in Claude Code", rotate: "New token issued", unregister: "Removed from Claude Code and Claude Desktop", enabled: h.enabled ? "Zippy Hub enabled" : "Zippy Hub disabled", revoke: "Access revoked" }[op]);
      setRevoking(false);
    },
  });
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const copy = () =>
    hub?.command &&
    navigator.clipboard.writeText(hub.command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, () => toast.error("Could not copy. Select the command and copy it by hand."));
  const busy = act.isPending;
  const on = hub?.enabled ?? true;
  return (
    <Card title="Claude MCP" desc="Use your whole Zippy from any Claude Code session or Claude Desktop: tickets, agents, inbox, pipelines, diffs, knowledge base and live terminals. Registered once for your user, works in every project.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Status ok={!!hub?.current && on} loading={isLoading}>
          {isLoading ? "Checking…" : !on ? "Disabled: clients are refused" : hub?.current ? `Registered as ${hub.name}` : hub?.registered ? "Registered with an old URL or token" : "Not registered"}
        </Status>
        <div className="flex flex-wrap items-center gap-2">
          {hub?.registered && (
            <Button variant="outline" size="sm" className="max-md:min-h-11" disabled={busy} onClick={() => act.mutate({ op: "unregister" })}>
              Remove
            </Button>
          )}
          {!hub?.current && on && (
            <Button size="sm" className="max-md:min-h-11" disabled={busy || isLoading} onClick={() => act.mutate({ op: "register" })}>
              <Plug aria-hidden /> {hub?.registered ? "Update" : hub?.desktop !== null ? "Register in Claude Code and Desktop" : "Register in Claude Code"}
            </Button>
          )}
          {hub && <EnableSwitch id="hub-enabled" checked={on} disabled={busy} onChange={(enabled) => act.mutate({ op: "enabled", body: { enabled } })} />}
        </div>
      </div>
      {hub && <HubTools tools={hub.tools} />}
      {hub?.command && (
        <div className="grid gap-2 border-t pt-4">
          <p className="text-muted-foreground text-xs">
            Manual setup: run this in a terminal, or point any other HTTP MCP client at <code className="bg-muted rounded px-1">{hub.url}</code> with the bearer token. Zippy must be running.
          </p>
          <div className="flex items-start gap-2">
            <code className="bg-muted min-w-0 flex-1 rounded-md px-2 py-1.5 text-xs break-all">{hub.command}</code>
            <Button variant="outline" size="icon" aria-label="Copy command" className="max-md:size-11 shrink-0" onClick={copy}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" className="max-md:min-h-11" disabled={busy} onClick={() => act.mutate({ op: "rotate" })}>
              <RefreshCw aria-hidden /> New token
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive max-md:min-h-11" disabled={busy} onClick={() => setRevoking(true)}>
              Revoke access
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title="Revoke Zippy Hub access?"
        desc="Deletes the token and removes the Claude Code and Claude Desktop registrations. Every client using it stops working at once. Register again to get a new token."
        action="Revoke access"
        pending={busy}
        onConfirm={() => act.mutate({ op: "revoke" })}
      />
    </Card>
  );
}

type Domain = { domain: string; url: string; certs: boolean; trusted: boolean; enabled: boolean; active: boolean; via: "herd" | "zippy" | null };

/** https://zippy.localhost with no port: local CA trusted in the keychain, served on 443 (through Herd's nginx when installed). */
function LocalDomain() {
  const qc = useQueryClient();
  const { data: d, isLoading } = useQuery({ queryKey: ["system", "domain"], queryFn: () => api.get<Domain>("/system/domain") });
  const [revoking, setRevoking] = useState(false);
  const act = useMutation({
    mutationFn: (op: "setup" | "disable" | "remove") => api.post<Domain>(`/system/domain/${op}`, {}, true),
    onSuccess: (r, op) => {
      qc.setQueryData(["system", "domain"], r);
      qc.invalidateQueries({ queryKey: ["system", "hub"] }); // hub URL follows the domain
      toast.success({ setup: `${r.url} is ready`, disable: "Local domain disabled", remove: "Certificate revoked and removed" }[op]);
      setRevoking(false);
    },
  });
  const ok = !!d?.active && d.trusted;
  return (
    <Card title="Local domain" desc="Open Zippy at https://zippy.localhost, no port, with a certificate your Mac trusts. Claude Code reaches the MCP at http://zippy.localhost (Update the registration above after changing this).">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Status ok={ok} loading={isLoading}>
          {isLoading ? "Checking…" : ok ? (
            <a href={d.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              {d.url}
              {d.via === "herd" && <span className="text-muted-foreground font-normal"> (via Laravel Herd)</span>}
            </a>
          ) : d?.certs && !d.enabled ? "Disabled" : d?.certs && !d.trusted ? "Certificate not trusted" : d?.certs ? "Set up, not serving (port 443 taken?)" : "Not set up"}
        </Status>
        <div className="flex flex-wrap items-center gap-2">
          {d?.certs && (
            <Button variant="outline" size="sm" className="text-destructive max-md:min-h-11" disabled={act.isPending} onClick={() => setRevoking(true)}>
              Revoke
            </Button>
          )}
          {!ok && (!d?.certs || d.enabled) && (
            <Button size="sm" className="max-md:min-h-11" disabled={act.isPending || isLoading} onClick={() => act.mutate("setup")}>
              {act.isPending ? "Waiting for your password…" : d?.certs ? "Repair" : "Set up HTTPS"}
            </Button>
          )}
          {d?.certs && <EnableSwitch id="domain-enabled" checked={d.enabled} disabled={act.isPending} onChange={(v) => act.mutate(v ? "setup" : "disable")} />}
        </div>
      </div>
      {!d?.certs && (
        <p className="text-muted-foreground text-xs">
          Creates a certificate authority limited to localhost names and adds it to your login keychain; macOS asks for your password once. Firefox may need <code className="bg-muted rounded px-1">security.enterprise_roots.enabled</code>.
        </p>
      )}
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title="Revoke the local certificate?"
        desc="Stops serving https://zippy.localhost, removes Zippy's certificate authority from your keychain and deletes its keys. Set up again any time."
        action="Revoke"
        pending={act.isPending}
        onConfirm={() => act.mutate("remove")}
      />
    </Card>
  );
}

type Phone = { installed: boolean; host: string | null; enabled: boolean; url: string | null; qr: string | null; error: string | null };
type PhoneOp = { op: "start" | "stop" | "rotate" | "forget" } | { op: "host"; host: string };

/** Open Zippy on your phone: token-gated Cloudflare tunnel, scan the QR to sign the phone in. */
function PhoneAccess() {
  const qc = useQueryClient();
  const { data: p, isLoading } = useQuery({ queryKey: ["system", "phone"], queryFn: () => api.get<Phone>("/system/phone") });
  const [host, setHost] = useState("");
  const act = useMutation({
    mutationFn: (a: PhoneOp) => api.post<Phone>(`/system/phone/${a.op}`, a.op === "host" ? { host: a.host } : {}, true),
    onSuccess: (r, a) => {
      qc.setQueryData(["system", "phone"], r);
      if (a.op === "host") (setHost(""), toast.success(`Connected https://${r.host}`));
      if (a.op === "rotate") toast.success("New link: phones signed in before must scan again");
    },
    onError: (e) => toast.error(e.message),
  });
  const busy = act.isPending ? act.variables.op : null;
  return (
    <Card
      title="Phone access"
      desc="Use Zippy from your phone, anywhere, through a Cloudflare tunnel. Only a phone that scanned this QR code gets in. Without your own domain the link changes each time you turn it on."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Status ok={!!p?.url} loading={isLoading}>
          {isLoading ? "Checking…" : busy === "start" ? "Starting tunnel…" : p?.url ? "On: scan with your phone camera" : p?.installed === false ? "Needs cloudflared: brew install cloudflared" : p?.error ?? "Off"}
        </Status>
        <div className="flex flex-wrap items-center gap-2">
          {p?.host && (
            <Button variant="outline" size="sm" className="max-md:min-h-11" disabled={!!busy} onClick={() => act.mutate({ op: "rotate" })}>
              New link
            </Button>
          )}
          <EnableSwitch id="phone-enabled" checked={!!p?.enabled} disabled={!!busy || isLoading || p?.installed === false} onChange={(v) => act.mutate({ op: v ? "start" : "stop" })} />
        </div>
      </div>
      {p?.qr && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="size-44 rounded-lg bg-white p-2 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: p.qr }} />
          <p className="text-muted-foreground max-w-xs text-xs">
            Anyone with this link can control Zippy on this Mac. Don't share it. {p.host ? "Use New link to sign every phone out." : "Turn this off to revoke it."}
          </p>
          <Button variant="outline" size="sm" className="max-md:min-h-11" onClick={() => navigator.clipboard.writeText(p.url!).then(() => toast.success("Link copied: open it in any browser to sign in"))}>
            Copy link
          </Button>
        </div>
      )}
      {p?.host ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">
            Fixed address <span className="text-foreground font-medium">https://{p.host}</span>, back on when Zippy starts.
          </span>
          <Button variant="outline" size="sm" className="text-destructive max-md:min-h-11" disabled={!!busy} onClick={() => act.mutate({ op: "forget" })}>
            Remove domain
          </Button>
        </div>
      ) : (
        p?.installed && (
          <form className="grid gap-2" onSubmit={(e) => (e.preventDefault(), host.trim() && act.mutate({ op: "host", host: host.trim() }))}>
            <label htmlFor="phone-host" className="text-xs font-medium">Keep the same link (optional)</label>
            <div className="flex flex-wrap gap-2">
              <Input id="phone-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="zippy.example.com" className="max-w-xs flex-1 font-mono text-[13px]" />
              <Button type="submit" size="sm" className="max-md:min-h-11" disabled={!!busy || !host.trim()}>
                {busy === "host" ? "Waiting for Cloudflare…" : "Connect domain"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">Needs a domain on your Cloudflare account. Your browser opens once to log in to Cloudflare; Zippy then creates a tunnel named “zippy” and a DNS record for this hostname.</p>
          </form>
        )
      )}
    </Card>
  );
}

/** Which hub tools Claude may call, by group. Danger tools start off. */
function HubTools({ tools }: { tools: HubTool[] }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.post<Hub>("/system/hub/tools", patch, true),
    onSuccess: (h) => qc.setQueryData(["system", "hub"], h),
  });
  const groups = [...new Set(tools.map((t) => t.group))];
  const on = tools.filter((t) => t.enabled).length;
  return (
    <Collapsible.Root className="border-t pt-4">
      <Collapsible.Trigger className="group flex w-full items-center justify-between gap-3 text-left text-sm font-medium max-md:min-h-11">
        <span>
          Allowed tools <span className="text-muted-foreground font-normal">({on} of {tools.length})</span>
        </span>
        <ChevronRight aria-hidden className="text-muted-foreground size-4 transition-transform group-data-[state=open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Content className="grid gap-4 pt-3">
        <p className="text-muted-foreground text-xs">Off tools are hidden from Claude. Changes apply to new Claude Code sessions (or run /mcp to reconnect).</p>
        {groups.map((g) => {
          const list = tools.filter((t) => t.group === g);
          const all = list.every((t) => t.enabled);
          return (
            <fieldset key={g} className="grid gap-1">
              <div className="flex items-center justify-between gap-3">
                <legend className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{g}</legend>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs max-md:min-h-11" disabled={set.isPending} onClick={() => set.mutate(Object.fromEntries(list.map((t) => [t.name, !all])))}>
                  {all ? "Turn all off" : "Turn all on"}
                </Button>
              </div>
              {list.map((t) => (
                <label key={t.name} className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 max-md:min-h-11">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="text-xs">{t.name}</code>
                      <span className={`rounded px-1.5 py-px text-[10px] font-medium ${RISK[t.risk].cls}`}>{RISK[t.risk].label}</span>
                    </span>
                    <span className="text-muted-foreground block text-xs">{t.summary}</span>
                  </span>
                  <Switch checked={t.enabled} disabled={set.isPending} onCheckedChange={(v) => set.mutate({ [t.name]: v })} aria-label={`Allow ${t.name}`} />
                </label>
              ))}
            </fieldset>
          );
        })}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

const WEBHOOK_PATH = "/api/linear/webhook";

function LinearSettings() {
  const org = useOrg();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const setPush = useApiMutation((linearPush: boolean) => api.patch(`/orgs/${org.id}`, { linearPush }), [keys.orgs]);
  const disconnect = useApiMutation(() => api.del(`/orgs/${org.id}/linear`), [keys.orgs]);
  const copy = () =>
    navigator.clipboard.writeText(WEBHOOK_PATH).then(() => {
      setCopied(true);
      toast.success("Webhook path copied");
      setTimeout(() => setCopied(false), 2000);
    });
  return (
    <div className="stagger grid gap-5">
      <Card title="Connection" desc="Connects through the Linear MCP server. Zippers post to Linear as you, with their name in the comment, ticket status syncs, and every Zipper gets the Linear MCP server.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Status ok={org.linearConnected}>{org.linearConnected ? `Connected to ${org.linearWorkspace}` : "Not connected"}</Status>
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
      <Card title="Sync to Linear" desc="Push Zippy activity to the linked Linear issue.">
        <SettingRow label="Sync from Zippy to Linear" hint="Status changes, Zipper comments and PR links. Linear comments still come in either way.">
          {(p) => <Switch {...p} checked={org.linearPush} disabled={!org.linearConnected || setPush.isPending} onCheckedChange={(v) => setPush.mutate(v)} />}
        </SettingRow>
      </Card>
      <Card title="Webhook (optional)" desc="So Linear comments reach Zippers.">
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

const BLANK_KB: KnowledgeInput = { kind: "do", text: "", url: "", workspaceId: null, pinned: false };

function KnowledgeBase() {
  const org = useOrg();
  const { data = [] } = useKnowledge(org.id);
  const { data: folders = [] } = useWorkspaces(org.id);
  const [form, setForm] = useState(BLANK_KB);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KnowledgeInput["kind"] | "all">("all");
  const inv = [keys.res(org.id, "knowledge")];
  const add = useApiMutation((v: KnowledgeInput) => api.post(`/orgs/${org.id}/knowledge`, v), inv);
  const patch = useApiMutation(({ id, ...v }: Partial<KnowledgeInput> & { id: string }) => api.patch(`/knowledge/${id}`, v), inv);
  const remove = useApiMutation((id: string) => api.del(`/knowledge/${id}`), inv);
  const folderName = (id: string | null) => (id ? (folders.find((f) => f.id === id)?.name ?? "folder") : "org");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = knowledgeInput.safeParse(form);
    if (!r.success) return toast.error(r.error.issues[0]!.message);
    add.mutate(r.data, { onSuccess: () => setForm({ ...BLANK_KB, kind: form.kind, workspaceId: form.workspaceId }) });
  }

  const needle = q.trim().toLowerCase();
  const shown = data
    .filter((k) => (kind === "all" || k.kind === kind) && (!needle || `${k.text} ${k.url}`.toLowerCase().includes(needle)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.uses - a.uses);

  return (
    <div className="stagger grid gap-4">
      <Card title="Add entry" desc="Short, imperative, one fact per entry. Pinned entries always reach Zippers.">
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[8rem_1fr_11rem_auto]" aria-label="New knowledge entry">
          <OptionSelect label="Kind" value={form.kind} onChange={(v) => setForm({ ...form, kind: v as KnowledgeInput["kind"] })} options={KB_KINDS.map((k) => ({ value: k, label: KB_LABELS[k] }))} />
          <Input aria-label="Text" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder={form.kind === "link" ? "What it is" : "e.g. Run pnpm db:push after schema changes"} />
          <OptionSelect label="Scope" value={form.workspaceId ?? "org"} onChange={(v) => setForm({ ...form, workspaceId: v === "org" ? null : v })} options={[{ value: "org", label: "Whole org" }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />
          <Button type="submit" disabled={add.isPending}><Plus aria-hidden /> Add</Button>
          {form.kind === "link" && (
            <Input aria-label="URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" className="font-mono text-[13px] sm:col-span-4" />
          )}
        </form>
      </Card>

      {data.length === 0 ? (
        <EmptyState icon={BookOpen} title="No knowledge yet" desc="Add your own entries, or let Zippers fill it as they work tickets and you correct them." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search aria-hidden className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input aria-label="Filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="pl-8" />
            </div>
            <LayoutGroup id="kb-kind">
              <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-0.5 rounded-xl border p-0.5">
                {(["all", ...KB_KINDS] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={`focus-visible:ring-ring/60 relative min-h-8 rounded-[10px] px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] ${kind === k ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {kind === k && <motion.span layoutId="kb-kind-pill" aria-hidden transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.6 }} className="bg-accent absolute inset-0 rounded-[10px]" />}
                    <span className="relative">{k === "all" ? `All ${data.length}` : `${KB_LABELS[k]} ${data.filter((d) => d.kind === k).length}`}</span>
                  </button>
                ))}
              </div>
            </LayoutGroup>
          </div>
          <ul className="settings-card bg-card stagger divide-y rounded-2xl border">
            {shown.map((k) => (
              <li key={k.id} className="rise flex items-start gap-3 px-4 py-2.5 first:rounded-t-2xl last:rounded-b-2xl">
                <span className="w-16 shrink-0 pt-1.5 text-[11px] font-medium uppercase text-muted-foreground">{KB_LABELS[k.kind]}</span>
                <div className="min-w-0 flex-1">
                  <textarea
                    aria-label="Entry text"
                    rows={1}
                    defaultValue={k.text}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== k.text && patch.mutate({ id: k.id, text: e.target.value.trim() })}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
                    className="focus-visible:bg-muted/60 w-full resize-none rounded-md bg-transparent px-1.5 py-1 text-[13px] break-words outline-none [field-sizing:content]"
                  />
                  <div className="flex flex-wrap items-center gap-1.5 px-1.5">
                    {/^https?:\/\//i.test(k.url) && <a href={k.url} target="_blank" rel="noreferrer" className="truncate font-mono text-xs text-[#5e6ad2] hover:underline">{k.url}</a>}
                    <Chip>{folderName(k.workspaceId)}</Chip>
                    {k.source === "agent" && <Chip><Bot aria-hidden className="inline size-3 align-[-2px]" /> Zipper</Chip>}
                    {k.uses > 0 && <Chip>used {k.uses}×</Chip>}
                  </div>
                </div>
                <Button size="icon" variant="ghost" aria-label={k.pinned ? "Unpin" : "Pin"} aria-pressed={k.pinned} onClick={() => patch.mutate({ id: k.id, pinned: !k.pinned })}>
                  <Pin aria-hidden className={k.pinned ? "fill-current" : "text-muted-foreground"} />
                </Button>
                <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => remove.mutate(k.id)}>
                  <Trash2 aria-hidden className="text-muted-foreground" />
                </Button>
              </li>
            ))}
            {!shown.length && <li className="text-muted-foreground px-4 py-6 text-center text-xs">No matches.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
