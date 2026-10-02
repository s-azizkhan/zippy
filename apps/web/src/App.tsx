import { QueryClientProvider } from "@tanstack/react-query";
import { Bot, ChevronDown, FolderGit2, Inbox, Layers, PanelLeftClose, PanelLeftOpen, Plus, Repeat, Search, Settings, SquarePen, TerminalSquare, Trash2, Workflow } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createBrowserRouter, Link, NavLink, Outlet, RouterProvider, useLocation, useMatches, useNavigate, useSearchParams } from "react-router";
import { ErrorPage, ErrorPreview, RouteError, errorCode } from "@/components/error-page";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { NewTicketDialog } from "@/components/new-ticket-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, keys, queryClient, useApiMutation, useInbox, useOrgs, useSystem, useWorkspaces } from "@/lib/api";
import { useUI } from "@/lib/store";
import { cn, isTyping } from "@/lib/utils";
import { AgentsPage } from "@/pages/agents";
import { InboxPage } from "@/pages/inbox";
import { Onboarding } from "@/pages/onboarding";
import { PipelinesPage } from "@/pages/pipelines";
import { RoutinesPage } from "@/pages/routines";
import { ConfirmDialog, FolderForm, SettingsPage } from "@/pages/settings";
import { TicketPage } from "@/pages/ticket";
import { TicketsPage } from "@/pages/tickets";


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
    "text-sidebar-foreground hover:bg-sidebar-accent flex h-7 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
    active && "bg-sidebar-accent text-sidebar-accent-foreground",
  );

function NavItem({ to, icon: Icon, label, count, match }: { to: string; icon: typeof Inbox; label: string; count?: number; match?: boolean }) {
  return (
    <NavLink to={to} end className={({ isActive }) => navCls(match ?? isActive)} aria-current={match ? "page" : undefined}>
      <Icon className="size-4 shrink-0 opacity-80" aria-hidden />
      <span className="sr-only flex-1 truncate wide:not-sr-only">{label}</span>
      {!!count && (
        <span key={count} className="pop text-muted-foreground hidden text-xs tabular-nums wide:inline" aria-label={`${count} waiting`}>
          {count}
        </span>
      )}
    </NavLink>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="hidden wide:block">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium"
        >
          {title} <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} aria-hidden />
        </button>
        {action}
      </div>
      {open && <div className="grid gap-px">{children}</div>}
    </div>
  );
}

function Sidebar() {
  const { data: orgs = [] } = useOrgs();
  const { orgId, setOrgId, setNewTicketOpen, setPaletteOpen, collapsed, toggleCollapsed } = useUI();
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0]!;
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const folder = params.get("folder");
  const view = params.get("view");
  const { data: inboxItems = [] } = useInbox(org.id);
  const inbox = inboxItems.length;
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const remove = useApiMutation((id: string) => api.del(`/workspaces/${id}`), [keys.res(org.id, "workspaces")]);

  return (
    <aside className={cn("bg-sidebar flex w-14 shrink-0 flex-col gap-4 px-2 py-2 transition-[width] duration-150 wide:w-60 wide:px-3", !collapsed && "sb-wide")} aria-label="Sidebar">
      <div className="flex flex-col items-center gap-1 wide:flex-row wide:justify-between">
        <Link to="/" className="hover:bg-sidebar-accent flex h-8 items-center gap-2 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label="Zippy home">
          <img src="/favicon.svg" alt="" className="size-6 shrink-0" />
          <span className="hidden text-base font-bold tracking-tight wide:inline">Zippy</span>
        </Link>
        <Tooltip>
          <TooltipTrigger asChild>
            <button aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleCollapsed} className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground hidden size-7 items-center justify-center rounded-md md:flex">
              {collapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{collapsed ? "Expand" : "Collapse"} ⌘B</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger className="hover:bg-sidebar-accent focus-visible:ring-ring/60 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-[13px] font-semibold outline-none focus-visible:ring-2">
            <span className="bg-primary flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold text-white" aria-hidden>
              {org.name.slice(0, 1)}
            </span>
            <span className="hidden truncate wide:inline">{org.name}</span>
            <ChevronDown className="text-muted-foreground hidden size-3.5 wide:block" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="text-muted-foreground text-xs">Switch organization</DropdownMenuLabel>
            {orgs.map((o) => (
              <DropdownMenuItem key={o.id} onSelect={() => setOrgId(o.id)}>
                {o.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/settings">Settings</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <button aria-label="Search" onClick={() => setPaletteOpen(true)} className="hover:bg-sidebar-accent hidden size-8 items-center justify-center rounded-md wide:flex">
              <Search className="size-4 opacity-80" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>Search ⌘K</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button aria-label="New issue" onClick={() => setNewTicketOpen(true)} className="bg-sidebar-accent hover:bg-accent hidden size-8 items-center justify-center rounded-md border wide:flex">
              <SquarePen className="size-4" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>New issue C</TooltipContent>
        </Tooltip>
      </div>

      <nav className="grid gap-px" aria-label="Main">
        <button aria-label="New issue" onClick={() => setNewTicketOpen(true)} className={cn(navCls(false), "wide:hidden")}>
          <Plus className="size-4" aria-hidden />
        </button>
        <NavItem to="/inbox" icon={Inbox} label="Inbox" count={inbox} />
        <NavItem to="/" icon={Layers} label="All issues" match={pathname === "/" && !view && !folder} />
      </nav>

      <Section title="Workspace">
        <NavItem to="/agents" icon={Bot} label="Agents" match={pathname.startsWith("/agents")} />
        <NavItem to="/pipelines" icon={Workflow} label="Pipelines" />
        <NavItem to="/routines" icon={Repeat} label="Routines" />
      </Section>

      <Section
        title="Your folders"
        action={
          <Tooltip>
            <TooltipTrigger asChild>
              <button aria-label="Add folder" onClick={() => setAdding(true)} className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 items-center justify-center rounded-md">
                <Plus className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add folder</TooltipContent>
          </Tooltip>
        }
      >
        {workspaces.map((w) => (
          <div key={w.id} className="group relative">
            <NavItem to={`/?folder=${w.id}`} icon={FolderGit2} label={w.name} match={pathname === "/" && folder === w.id} />
            <button
              aria-label={`Remove ${w.name}`}
              onClick={() => setRemoving(w)}
              className="text-muted-foreground hover:text-destructive absolute top-1 right-1 flex size-5 items-center justify-center rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
        {!workspaces.length && (
          <button onClick={() => setAdding(true)} className="text-muted-foreground px-2 text-left text-xs hover:underline">
            Add a working folder
          </button>
        )}
      </Section>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New working folder</DialogTitle>
          </DialogHeader>
          <FolderForm onDone={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
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
      />

      <nav className="grid gap-px wide:hidden" aria-label="Workspace">
        <NavItem to="/agents" icon={Bot} label="Agents" match={pathname.startsWith("/agents")} />
        <NavItem to="/pipelines" icon={Workflow} label="Pipelines" />
        <NavItem to="/routines" icon={Repeat} label="Routines" />
      </nav>

      <nav className="mt-auto grid gap-px" aria-label="Settings">
        <NavItem to="/settings" icon={Settings} label="Settings" />
        <ThemeToggle />
      </nav>
    </aside>
  );
}

function Layout() {
  useShortcuts();
  const { data: orgs, isLoading, error, refetch } = useOrgs();
  const { orgId, setOrgId } = useUI();
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
  if (!org) return <Onboarding />;

  return (
    <div className="bg-sidebar flex h-dvh">
      {title?.title && <title>{`${title.title} | Zippy - Agent coworkers for your tickets`}</title>}
      <a href="#main" className="bg-background sr-only z-50 rounded-md px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <Sidebar />
      <main id="main" tabIndex={-1} className="bg-background relative my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border outline-none">
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
      <CommandPalette org={org} />
      <NewTicketDialog org={org} />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { path: "/", element: <TicketsPage />, handle: { title: "Tickets" } },
      { path: "/t/:id", element: <TicketPage /> },
      { path: "/inbox", element: <InboxPage />, handle: { title: "Inbox" } },
      { path: "/agents", element: <AgentsPage />, handle: { title: "Agents" } },
      { path: "/agents/:handle", element: <AgentsPage />, handle: { title: "Agents" } },
      { path: "/pipelines", element: <PipelinesPage />, handle: { title: "Pipelines" } },
      { path: "/routines", element: <RoutinesPage />, handle: { title: "Routines" } },
      { path: "/settings", element: <SettingsPage />, handle: { title: "Settings" } },
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
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </MotionConfig>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
