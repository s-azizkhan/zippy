import { QueryClientProvider } from "@tanstack/react-query";
import { Activity as ActivityIcon, Bot as BotIcon, ChevronDown, MessageSquare, ChevronsUpDown, FolderGit2 as FolderGit2Icon, Inbox as MailboxIcon, Layers as LayersIcon, RefreshCw as RefreshCWIcon, Settings as SettingsIcon, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { PanelLeftCloseIcon as PanelLeftClose } from "@/components/ui/panel-left-close";
import { PanelLeftOpenIcon as PanelLeftOpen } from "@/components/ui/panel-left-open";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { SearchIcon as Search } from "@/components/ui/search";
import { SquarePenIcon as SquarePen } from "@/components/ui/square-pen";
import { TerminalIcon as TerminalSquare } from "@/components/ui/terminal";
import { MotionConfig, motion } from "motion/react";
import { ThemeProvider } from "next-themes";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { createBrowserRouter, Link, NavLink, Outlet, RouterProvider, useLocation, useMatches, useNavigate, useSearchParams } from "react-router";
import { ErrorPage, ErrorPreview, RouteError, errorCode } from "@/components/error-page";
import { MobileNav } from "@/components/mobile-nav";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { LinearIssueModal } from "@/components/linear-issues";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, keys, queryClient, useApiMutation, useInbox, useOrgs, useRunning, useSystem, useUsage, useWorkspaces } from "@/lib/api";
import { useUI } from "@/lib/store";
import { cn, isTyping } from "@/lib/utils";
const Onboarding = lazy(() => import("@/pages/onboarding").then((m) => ({ default: m.Onboarding })));
const NewTicketDialog = lazy(() => import("@/components/new-ticket-dialog").then((m) => ({ default: m.NewTicketDialog })));
const FolderForm = lazy(() => import("@/pages/settings").then((m) => ({ default: m.FolderForm })));
const ConfirmDialog = lazy(() => import("@/pages/settings").then((m) => ({ default: m.ConfirmDialog })));
const page = (load: () => Promise<Record<string, any>>, name: string) => ({ lazy: async () => ({ Component: (await load())[name] }) });


function useShortcuts() {
  const { setPaletteOpen, setNewTicketOpen } = useUI();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(!useUI.getState().paletteOpen);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        useUI.getState().toggleCollapsed();
      } else if (!isTyping(e) && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === "c") {
        e.preventDefault();
        setNewTicketOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, setNewTicketOpen]);
}

const navCls = (active: boolean) =>
  cn(
    "group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
  );

function NavItem({ to, icon: Icon, label, count, match, color = "#7c87f0" }: { to: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; label: string; count?: number; match?: boolean; color?: string }) {
  return (
    <NavLink to={to} end aria-current={match ? "page" : undefined} style={{ "--c": color } as React.CSSProperties} className={({ isActive }) => navCls(match ?? isActive)}>
      {({ isActive }) => {
        const on = match ?? isActive;
        return (
          <>
            {on ? (
              <motion.span layoutId="nav-active" transition={{ type: "spring", stiffness: 500, damping: 38 }} className="absolute inset-0 rounded-lg bg-[linear-gradient(90deg,color-mix(in_oklab,var(--c)_20%,transparent),color-mix(in_oklab,var(--c)_5%,transparent))] ring-1 ring-[color-mix(in_oklab,var(--c)_30%,transparent)]">
                <span className="absolute top-2 bottom-2 -left-px w-0.5 rounded-full bg-[var(--c)] shadow-[0_0_10px_1px_var(--c)]" />
              </motion.span>
            ) : (
              <span className="absolute inset-0 rounded-lg bg-[color-mix(in_oklab,var(--c)_10%,transparent)] opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            )}
            <Icon className={cn("relative size-4 shrink-0 transition-all duration-200 group-hover:-rotate-6 group-hover:scale-110 group-hover:text-[var(--c)]", on && "text-[var(--c)] drop-shadow-[0_0_6px_var(--c)]")} strokeWidth={1.75} aria-hidden />
            <span className="sr-only relative flex-1 truncate wide:not-sr-only">{label}</span>
            {!!count && (
              <span key={count} className="pop relative bg-[color-mix(in_oklab,var(--c)_18%,transparent)] text-[var(--c)] hidden min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums wide:inline" aria-label={`${count} waiting`}>
                {count}
              </span>
            )}
          </>
        );
      }}
    </NavLink>
  );
}

const rail = "hidden wide:block";

function Section({ title, action, rail: railHidden, children }: { title: string; action?: React.ReactNode; rail?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={cn(railHidden && rail)}>
      <div className="bg-border mx-2 mb-2 h-px wide:hidden" />
      <div className="hidden items-center justify-between wide:flex">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="text-muted-foreground/80 hover:text-foreground flex h-6 items-center gap-1 rounded-md px-2.5 font-mono text-[10px] font-medium tracking-[0.14em] uppercase"
        >
          {title} <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} aria-hidden />
        </button>
        {action}
      </div>
      <div className={cn("grid gap-0.5", !open && "wide:hidden")}>{children}</div>
    </div>
  );
}

const left = (iso: string) => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

const WINDOWS = [
  { k: "five_hour", title: "Session · 5h", ms: 5 * 3600_000 },
  { k: "seven_day", title: "Week · all models", ms: 7 * 86400_000 },
] as const;

function UsageMeter() {
  const { data } = useUsage();
  if (!data) return null;
  return (
    <div className="border-foreground/[0.07] bg-foreground/[0.03] mb-1 hidden gap-3 rounded-xl border p-3 wide:grid" aria-label="Claude usage">
      {WINDOWS.map(({ k, title, ms }) => {
        const w = data[k];
        if (!w) return null;
        const pct = Math.min(100, Math.round(w.utilization));
        const elapsed = Math.min(100, Math.max(0, 100 - ((Date.parse(w.resets_at) - Date.now()) / ms) * 100));
        const hot = pct >= 90;
        return (
          <div key={k} title={`Resets ${new Date(w.resets_at).toLocaleString()}`}>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground text-[11px] font-medium">{title}</span>
              <span className={cn("font-mono text-[11px] font-semibold tabular-nums", hot ? "text-destructive" : "text-foreground")}>{pct}%</span>
            </div>
            <div className="bg-foreground/[0.08] relative mt-1.5 h-1 rounded-full">
              <div
                className={cn("h-full rounded-full", hot ? "bg-destructive shadow-[0_0_8px_var(--color-destructive)]" : "from-primary bg-gradient-to-r to-cyan-400 shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_60%,transparent)]")}
                style={{ width: `${pct}%` }}
              />
              <div className="bg-foreground/50 absolute -top-0.5 h-2 w-px rounded-full" style={{ left: `${elapsed}%` }} />
            </div>
            <div className="text-muted-foreground/70 mt-1 font-mono text-[10px]">resets {left(w.resets_at)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Sidebar() {
  const { data: orgs = [] } = useOrgs();
  const { orgId, setOrgId, setNewTicketOpen, setPaletteOpen, setOnboardingOpen, collapsed, toggleCollapsed } = useUI();
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0]!;
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const folder = params.get("folder");
  const view = params.get("view");
  const { data: inboxItems = [] } = useInbox(org.id);
  const inbox = inboxItems.length;
  const { data: running = [] } = useRunning(org.id);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const remove = useApiMutation((id: string) => api.del(`/workspaces/${id}`), [keys.res(org.id, "workspaces")]);

  return (
    <aside className={cn("hidden md:flex bg-sidebar/80 border-foreground/[0.07] relative m-2 mr-0 w-14 shrink-0 flex-col gap-3 overflow-hidden rounded-2xl border px-2 py-2.5 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.06)] backdrop-blur-xl transition-[width] duration-150 wide:w-60 wide:px-2.5", !collapsed && "sb-wide")} aria-label="Sidebar">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-[radial-gradient(100%_100%_at_50%_0%,color-mix(in_oklab,var(--color-primary)_16%,transparent),transparent)]" />

      <div className="relative flex flex-col items-center gap-1 wide:flex-row wide:justify-between">
        <Link to="/" className="hover:bg-foreground/[0.05] flex h-8 items-center gap-2 rounded-lg px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label="Zippy home">
          <img src="/favicon.svg" alt="" className="size-6 shrink-0" />
          <span className="hidden text-[15px] font-bold tracking-tight wide:inline">Zippy</span>
        </Link>
        <Tooltip>
          <TooltipTrigger asChild>
            <button aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleCollapsed} className="text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground hidden size-7 items-center justify-center rounded-lg md:flex">
              {collapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{collapsed ? "Expand" : "Collapse"} ⌘B</TooltipContent>
        </Tooltip>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger className="border-foreground/[0.07] bg-foreground/[0.03] hover:bg-foreground/[0.06] focus-visible:ring-ring/60 relative flex h-10 min-w-0 items-center justify-center gap-2.5 rounded-xl border px-1.5 text-left outline-none transition-colors focus-visible:ring-2 wide:justify-start">
          <span className="from-primary flex size-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br to-cyan-500 text-[11px] font-bold text-white shadow-sm" aria-hidden>
            {org.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden min-w-0 flex-1 leading-tight wide:block">
            <span className="block truncate text-[13px] font-semibold">{org.name}</span>
            <span className="text-muted-foreground block font-mono text-[10px]">organization</span>
          </span>
          <ChevronsUpDown className="text-muted-foreground hidden size-3.5 wide:block" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-muted-foreground text-xs">Switch organization</DropdownMenuLabel>
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => setOrgId(o.id)}>
              {o.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setOnboardingOpen(true)}>
            <Plus className="size-4" aria-hidden /> New organization
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/settings">Settings</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="relative hidden items-center gap-1.5 wide:flex">
        <button onClick={() => setPaletteOpen(true)} className="border-foreground/[0.07] text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/[0.06] bg-background/40 focus-visible:ring-ring/60 flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2">
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="flex-1 truncate text-left">Search…</span>
          <kbd className="bg-foreground/[0.06] rounded px-1.5 font-mono text-[10px]">⌘K</kbd>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button aria-label="New issue" onClick={() => setNewTicketOpen(true)} className="from-primary focus-visible:ring-ring/60 flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b to-[color-mix(in_oklab,var(--color-primary)_80%,black)] text-white shadow-[0_4px_14px_-4px_var(--color-primary),inset_0_1px_0_rgb(255_255_255/0.25)] outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 active:translate-y-0">
              <SquarePen className="size-4" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>New issue C</TooltipContent>
        </Tooltip>
      </div>

      <div className="relative -mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 [scrollbar-width:none]">
        <nav className="grid gap-0.5" aria-label="Main">
          <button aria-label="Search" onClick={() => setPaletteOpen(true)} className={cn(navCls(false), "wide:hidden")}>
            <Search className="relative size-4" aria-hidden />
          </button>
          <button aria-label="New issue" onClick={() => setNewTicketOpen(true)} className={cn(navCls(false), "wide:hidden")}>
            <Plus className="relative size-4" aria-hidden />
          </button>
          <NavItem to="/chat" icon={MessageSquare} color="#e879f9" label="Chat" match={pathname.startsWith("/chat")} />
          <NavItem to="/inbox" icon={MailboxIcon} color="#f2994a" label="Inbox" count={inbox} />
          <NavItem to="/" icon={LayersIcon} color="#7c87f0" label="All issues" match={pathname === "/" && !view && !folder} />
        </nav>

        <Section title="Workspace">
          <NavItem to="/zippers" icon={BotIcon} color="#4cb782" label="Zippers" match={pathname.startsWith("/zippers")} />
          <NavItem to="/running" icon={ActivityIcon} color="#4cb782" label="Running" count={running.length} />
          <NavItem to="/pipelines" icon={WorkflowIcon} color="#26b5ce" label="Pipelines" />
          <NavItem to="/routines" icon={RefreshCWIcon} color="#f2c94c" label="Routines" />
        </Section>

        <Section
          title="Folders"
          rail
          action={
            <Tooltip>
              <TooltipTrigger asChild>
                <button aria-label="Add folder" onClick={() => setAdding(true)} className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground flex size-6 items-center justify-center rounded-md">
                  <Plus className="size-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>Add folder</TooltipContent>
            </Tooltip>
          }
        >
          {workspaces.map((w) => (
            <div key={w.id} className="group/f relative">
              <NavItem to={`/?folder=${w.id}`} icon={FolderGit2Icon} color="#c084fc" label={w.name} match={pathname === "/" && folder === w.id} />
              <button
                aria-label={`Remove ${w.name}`}
                onClick={() => setRemoving(w)}
                className="text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded opacity-0 group-hover/f:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
          {!workspaces.length && (
            <button onClick={() => setAdding(true)} className="text-muted-foreground border-foreground/10 hover:text-foreground mx-1 rounded-lg border border-dashed px-2.5 py-2 text-left text-xs transition-colors">
              + Add a working folder
            </button>
          )}
        </Section>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New working folder</DialogTitle>
          </DialogHeader>
          {adding && <Suspense fallback={null}><FolderForm onDone={() => setAdding(false)} /></Suspense>}
        </DialogContent>
      </Dialog>
      {removing && <Suspense fallback={null}><ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name}?`}
        desc="The folder is removed from Zippy. Files on disk are not touched."
        action="Remove folder"
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(removing!.id, {
            onSuccess: () => {
              toast.success("Folder removed");
              if (folder === removing!.id) navigate("/");
              setRemoving(null);
            },
          })
        }
      /></Suspense>}

      <div className="relative grid gap-1">
        <UsageMeter />
        <div className="border-foreground/[0.07] bg-foreground/[0.03] grid gap-px rounded-xl border p-1">
          <NavItem to="/settings" icon={SettingsIcon} color="#94a3b8" label="Settings" />
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}

function Layout() {
  useShortcuts();
  const { data: orgs, isLoading, error, refetch } = useOrgs();
  const { orgId, setOrgId, onboardingOpen, setOnboardingOpen, newTicketOpen } = useUI();
  const [params, setParams] = useSearchParams();
  const linkOrg = params.get("org"); // deep links (Slack) name their org
  const org = orgs?.find((o) => o.id === (linkOrg ?? orgId)) ?? orgs?.[0];
  const { data: system } = useSystem();

  useEffect(() => {
    if (linkOrg && org?.id === linkOrg) {
      params.delete("org");
      setParams(params, { replace: true });
    }
  }, [linkOrg, org, params, setParams]);

  useEffect(() => {
    if (org && org.id !== orgId) setOrgId(org.id);
  }, [org, orgId, setOrgId]);

  useEffect(() => {
    if (isLoading) return;
    const boot = document.getElementById("boot");
    if (!boot) return;
    boot.classList.add("done");
    try { sessionStorage.booted = "1"; } catch { /* private mode */ }
    // Mark glides into the sidebar logo; plain fade if no target or reduced motion.
    const mark = boot.querySelector("img");
    const dest = document.querySelector<HTMLElement>('aside img[src="/favicon.svg"]');
    const from = mark?.getBoundingClientRect();
    const to = dest?.getBoundingClientRect();
    let ms = 450;
    if (mark && dest && from && to && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const start = getComputedStyle(mark).transform;
      mark.style.animation = "none";
      dest.style.opacity = "0";
      ms = 600;
      mark.animate(
        [{ transform: start }, { transform: `translate(${to.x + to.width / 2 - from.x - from.width / 2}px, ${to.y + to.height / 2 - from.y - from.height / 2}px) scale(${to.width / from.width})` }],
        { duration: ms, easing: "cubic-bezier(0.65, 0, 0.2, 1)", fill: "forwards" },
      );
    } else boot.style.opacity = "0";
    const t = setTimeout(() => {
      boot.remove();
      if (dest) dest.style.opacity = "";
    }, ms);
    return () => clearTimeout(t);
  }, [isLoading]);

  const { pathname } = useLocation();
  const title = useMatches().at(-1)?.handle as { title?: string } | undefined;

  if (isLoading) return null;
  if (error) return <ErrorPage code={errorCode(error)} error={error} onRetry={() => refetch()} />;
  if (!org || onboardingOpen) return <Suspense fallback={null}><Onboarding onCancel={org ? () => setOnboardingOpen(false) : undefined} /></Suspense>;

  return (
    <div className="bg-sidebar flex h-dvh max-md:bg-background">
      {title?.title && <title>{`${title.title} | Zippy - Zipper coworkers for your tickets`}</title>}
      <a href="#main" className="bg-background sr-only z-50 rounded-md px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <Sidebar />
      <main id="main" tabIndex={-1} className="bg-background relative flex min-w-0 flex-1 flex-col overflow-hidden outline-none max-md:pt-[env(safe-area-inset-top)] max-md:pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:m-2 md:rounded-lg md:border">
        {system && !system.auth.loggedIn && (
          <div role="alert" className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-[13px] text-amber-800 dark:text-amber-300">
            <TerminalSquare className="size-4 shrink-0" aria-hidden />
            Claude is not logged in, so agents cannot run. Run <code className="bg-background rounded px-1.5 py-0.5 font-mono">claude auth login</code> and start Zippy from that terminal.
          </div>
        )}
        <motion.div key={pathname} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="flex min-h-0 flex-1 flex-col">
          <Outlet context={{ org }} />
        </motion.div>
      </main>
      <MobileNav orgId={org.id} />
      <CommandPalette org={org} />
      {newTicketOpen && <Suspense fallback={null}><NewTicketDialog org={org} /></Suspense>}
      <LinearIssueModal />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { path: "/", ...page(() => import("@/pages/tickets"), "TicketsPage"), handle: { title: "Tickets" } },
      { path: "/t/:id", ...page(() => import("@/pages/ticket"), "TicketPage") },
      { path: "/chat", ...page(() => import("@/pages/chat"), "ChatPage"), handle: { title: "Chat" } },
      { path: "/chat/:id", ...page(() => import("@/pages/chat"), "ChatPage"), handle: { title: "Chat" } },
      { path: "/inbox", ...page(() => import("@/pages/inbox"), "InboxPage"), handle: { title: "Inbox" } },
      { path: "/zippers", ...page(() => import("@/pages/agents"), "AgentsPage"), handle: { title: "Zippers" } },
      { path: "/zippers/:handle", ...page(() => import("@/pages/agents"), "AgentsPage"), handle: { title: "Zippers" } },
      { path: "/running", ...page(() => import("@/pages/running"), "RunningPage"), handle: { title: "Running" } },
      { path: "/pipelines", ...page(() => import("@/pages/pipelines"), "PipelinesPage"), handle: { title: "Pipelines" } },
      { path: "/routines", ...page(() => import("@/pages/routines"), "RoutinesPage"), handle: { title: "Routines" } },
      { path: "/routines/new", ...page(() => import("@/pages/routines"), "RoutineEditor"), handle: { title: "New routine" } },
      { path: "/routines/:id", ...page(() => import("@/pages/routines"), "RoutineDetail"), handle: { title: "Routines" } },
      { path: "/routines/:id/edit", ...page(() => import("@/pages/routines"), "RoutineEditor"), handle: { title: "Edit routine" } },
      { path: "/settings", ...page(() => import("@/pages/settings"), "SettingsPage"), handle: { title: "Settings" } },
      ...(import.meta.env.DEV ? [{ path: "/error/:code", element: <ErrorPreview /> }] : []),
      { path: "*", element: <ErrorPage code={404} compact />, handle: { title: "Page not found" } },
    ],
  },
]);

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={400}>
            <RouterProvider router={router} />
            <Toaster position={innerWidth < 768 ? "top-center" : "top-right"} closeButton />
          </TooltipProvider>
        </MotionConfig>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
