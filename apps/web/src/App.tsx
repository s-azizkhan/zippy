import { QueryClientProvider } from "@tanstack/react-query";
import { Bot, ChevronDown, FolderGit2, Inbox, Layers, Plus, Search, Settings, SquarePen, TerminalSquare, Workflow } from "lucide-react";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { createBrowserRouter, Link, NavLink, Outlet, RouterProvider, useLocation } from "react-router";
import { CommandPalette } from "@/components/command-palette";
import { NewTicketDialog } from "@/components/new-ticket-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { queryClient, useInbox, useOrgs, useSystem, useWorkspaces } from "@/lib/api";
import { useUI } from "@/lib/store";
import { cn, isTyping } from "@/lib/utils";
import { AgentsPage } from "@/pages/agents";
import { InboxPage } from "@/pages/inbox";
import { Onboarding } from "@/pages/onboarding";
import { PipelinesPage } from "@/pages/pipelines";
import { SettingsPage } from "@/pages/settings";
import { TicketPage } from "@/pages/ticket";
import { TicketsPage } from "@/pages/tickets";


function useShortcuts() {
  const { setPaletteOpen, setNewTicketOpen } = useUI();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(!useUI.getState().paletteOpen);
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
      <span className="sr-only flex-1 truncate md:not-sr-only">{label}</span>
      {!!count && (
        <span className="text-muted-foreground hidden text-xs tabular-nums md:inline" aria-label={`${count} waiting`}>
          {count}
        </span>
      )}
    </NavLink>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="hidden md:block">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium"
      >
        {title} <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} aria-hidden />
      </button>
      {open && <div className="grid gap-px">{children}</div>}
    </div>
  );
}

function Sidebar() {
  const { data: orgs = [] } = useOrgs();
  const { orgId, setOrgId, setNewTicketOpen, setPaletteOpen } = useUI();
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0]!;
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const folder = params.get("folder");
  const view = params.get("view");
  const { data: inboxItems = [] } = useInbox(org.id);
  const inbox = inboxItems.length;

  return (
    <aside className="bg-sidebar flex w-14 shrink-0 flex-col gap-4 px-2 py-2 md:w-60 md:px-3" aria-label="Sidebar">
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger className="hover:bg-sidebar-accent focus-visible:ring-ring/60 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-[13px] font-semibold outline-none focus-visible:ring-2">
            <span className="bg-primary flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold text-white" aria-hidden>
              {org.name.slice(0, 1)}
            </span>
            <span className="hidden truncate md:inline">{org.name}</span>
            <ChevronDown className="text-muted-foreground hidden size-3.5 md:block" aria-hidden />
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
            <button aria-label="Search" onClick={() => setPaletteOpen(true)} className="hover:bg-sidebar-accent hidden size-8 items-center justify-center rounded-md md:flex">
              <Search className="size-4 opacity-80" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>Search ⌘K</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button aria-label="New issue" onClick={() => setNewTicketOpen(true)} className="bg-sidebar-accent hover:bg-accent hidden size-8 items-center justify-center rounded-md border md:flex">
              <SquarePen className="size-4" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>New issue C</TooltipContent>
        </Tooltip>
      </div>

      <nav className="grid gap-px" aria-label="Main">
        <button aria-label="New issue" onClick={() => setNewTicketOpen(true)} className={cn(navCls(false), "md:hidden")}>
          <Plus className="size-4" aria-hidden />
        </button>
        <NavItem to="/inbox" icon={Inbox} label="Inbox" count={inbox} />
        <NavItem to="/" icon={Layers} label="All issues" match={pathname === "/" && !view && !folder} />
      </nav>

      <Section title="Workspace">
        <NavItem to="/agents" icon={Bot} label="Agents" />
        <NavItem to="/pipelines" icon={Workflow} label="Pipelines" />
        <NavItem to="/settings" icon={Settings} label="Settings" />
      </Section>

      <Section title="Your folders">
        {workspaces.map((w) => (
          <NavItem key={w.id} to={`/?folder=${w.id}`} icon={FolderGit2} label={w.name} match={pathname === "/" && folder === w.id} />
        ))}
        {!workspaces.length && (
          <Link to="/settings" className="text-muted-foreground px-2 text-xs hover:underline">
            Add a working folder
          </Link>
        )}
      </Section>

      <nav className="grid gap-px md:hidden" aria-label="Workspace">
        <NavItem to="/agents" icon={Bot} label="Agents" />
        <NavItem to="/pipelines" icon={Workflow} label="Pipelines" />
        <NavItem to="/settings" icon={Settings} label="Settings" />
      </nav>
    </aside>
  );
}

function Layout() {
  useShortcuts();
  const { data: orgs, isLoading } = useOrgs();
  const { orgId, setOrgId } = useUI();
  const org = orgs?.find((o) => o.id === orgId) ?? orgs?.[0];
  const { data: system } = useSystem();

  useEffect(() => {
    if (org && org.id !== orgId) setOrgId(org.id);
  }, [org, orgId, setOrgId]);

  if (isLoading) return null;
  if (!org) return <Onboarding />;

  return (
    <div className="bg-sidebar flex h-dvh">
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
        <Outlet context={{ org }} />
      </main>
      <CommandPalette org={org} />
      <NewTicketDialog org={org} />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <TicketsPage /> },
      { path: "/t/:id", element: <TicketPage /> },
      { path: "/inbox", element: <InboxPage /> },
      { path: "/agents", element: <AgentsPage /> },
      { path: "/pipelines", element: <PipelinesPage /> },
      { path: "/settings", element: <SettingsPage /> },
    ],
  },
]);

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={400}>
          <RouterProvider router={router} />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
