import { Activity, Bot, Inbox, Layers, ListChecks, Check, ChevronRight, FolderGit2, MessageSquare, MoreHorizontal, Newspaper, Plus, RefreshCw, Search, Settings, Workflow } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { ThemeToggle } from "@/components/theme-toggle";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useOrgs, useRunning, useWorkspaces } from "@/lib/api";
import { useInboxView } from "@/lib/inbox";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";

type Icon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

const MORE: { to: string; label: string; icon: Icon; color: string }[] = [
  { to: "/chat", label: "Chat", icon: MessageSquare, color: "#e879f9" },
  { to: "/todo", label: "Todo", icon: ListChecks, color: "#f472b6" },
  { to: "/news", label: "Trending", icon: Newspaper, color: "#60a5fa" },
  { to: "/running", label: "Running", icon: Activity, color: "#4cb782" },
  { to: "/pipelines", label: "Pipelines", icon: Workflow, color: "#26b5ce" },
  { to: "/routines", label: "Routines", icon: RefreshCw, color: "#f2c94c" },
  { to: "/settings", label: "Settings", icon: Settings, color: "#94a3b8" },
];

const spring = { type: "spring", stiffness: 420, damping: 30, mass: 0.7 } as const;

function Item({ icon: Icon, label, color, on, count, to, onClick }: { icon: Icon; label: string; color: string; on: boolean; count?: number; to?: string; onClick?: () => void }) {
  const inner = (
    <>
      {on && <motion.span layoutId="dock-pill" transition={spring} className="absolute inset-0 rounded-full bg-[color-mix(in_oklab,var(--c)_22%,transparent)] shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_0_14px_color-mix(in_oklab,var(--c)_25%,transparent)] ring-1 ring-white/20" />}
      <motion.span key={on ? "on" : "off"} initial={on ? { scale: 0.6, rotate: -18 } : false} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 500, damping: 14 }} className="relative">
        <Icon className={cn("size-[22px] transition-colors duration-200", on ? "text-[var(--c)]" : "text-foreground/60")} strokeWidth={on ? 2.2 : 1.8} aria-hidden />
        <AnimatePresence>
          {!!count && (
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: "spring", stiffness: 600, damping: 16 }} className="bg-destructive absolute -top-1.5 -right-2 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums ring-2 ring-[var(--background)]">
              {count}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.span>
      <AnimatePresence initial={false}>
        {on && (
          <motion.span initial={{ width: 0, opacity: 0 }} animate={{ width: "auto", opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ ...spring, opacity: { duration: 0.18 } }} className="relative overflow-hidden text-[13px] font-semibold whitespace-nowrap">
            <span className="block pr-0.5">{label}</span>
          </motion.span>
        )}
      </AnimatePresence>
    </>
  );
  const cls = "relative flex h-11 items-center gap-2 rounded-full px-3 outline-none";
  return (
    <motion.div layout transition={spring} whileTap={{ scale: 0.88 }} style={{ "--c": color } as React.CSSProperties}>
      {to ? (
        <NavLink to={to} aria-label={label} aria-current={on ? "page" : undefined} className={cls}>
          {inner}
        </NavLink>
      ) : (
        <button aria-label={label} onClick={onClick} className={cls}>
          {inner}
        </button>
      )}
    </motion.div>
  );
}

export function MobileNav({ orgId }: { orgId: string }) {
  const { pathname, search } = useLocation();
  const { setNewTicketOpen, setPaletteOpen, setOrgId, setOnboardingOpen } = useUI();
  const { data: orgs = [] } = useOrgs();
  const { unread: inbox } = useInboxView(orgId);
  const { data: running = [] } = useRunning(orgId);
  const { data: folders = [] } = useWorkspaces(orgId);
  const [more, setMore] = useState(false);
  const [orgOpen, setOrgOpen] = useState(false);
  const moreOn = MORE.some((m) => pathname.startsWith(m.to));
  const issuesOn = (pathname === "/" || pathname.startsWith("/t/")) && !search.includes("view=");

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 flex items-center justify-center gap-2.5 px-3 md:hidden">
        <motion.nav initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ ...spring, delay: 0.1 }} aria-label="Main" className="liquid pointer-events-auto flex items-center gap-0.5 rounded-full p-1.5">
          <Item to="/" icon={Layers} label="Issues" color="#7c87f0" on={issuesOn} />
          <Item to="/inbox" icon={Inbox} label="Inbox" color="#f2994a" on={pathname.startsWith("/inbox")} count={inbox} />
          <Item to="/zippers" icon={Bot} label="Zippers" color="#4cb782" on={pathname.startsWith("/zippers")} count={running.length} />
          <Item icon={MoreHorizontal} label="More" color="#94a3b8" on={moreOn} onClick={() => setMore(true)} />
        </motion.nav>
        <motion.button initial={{ scale: 0, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} transition={{ ...spring, delay: 0.25 }} whileTap={{ scale: 0.85, rotate: 90 }} aria-label="New issue" onClick={() => setNewTicketOpen(true)} className="liquid pointer-events-auto relative flex size-[56px] shrink-0 items-center justify-center overflow-hidden rounded-full text-white outline-none">
          <span aria-hidden className="from-primary absolute inset-1 rounded-full bg-gradient-to-br to-cyan-400 shadow-[inset_0_1px_0_rgb(255_255_255/0.5)]" />
          <span aria-hidden className="fab-sheen absolute inset-0" />
          <Plus className="relative size-6" strokeWidth={2.4} aria-hidden />
        </motion.button>
      </div>

      <Dialog open={more} onOpenChange={setMore}>
        <DialogContent showCloseButton={false} className="md:hidden">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg font-semibold tracking-tight">More</DialogTitle>
            <ThemeToggle />
          </div>
          <button onClick={() => (setMore(false), setPaletteOpen(true))} className="glass sheet-up text-muted-foreground flex h-11 items-center gap-2.5 rounded-2xl px-3.5 text-sm active:scale-[0.98]">
            <Search className="size-4" aria-hidden />
            Search or jump to…
          </button>
          <div className="grid grid-cols-4 gap-y-4">
            {MORE.map(({ to, label, icon: I, color }, i) => (
              <Link key={to} to={to} onClick={() => setMore(false)} style={{ "--c": color, animationDelay: `${i * 40}ms` } as React.CSSProperties} className="sheet-up flex flex-col items-center gap-1.5 text-[11px] font-medium active:scale-90">
                <span className="relative flex size-14 items-center justify-center rounded-[1.1rem] bg-[linear-gradient(145deg,color-mix(in_oklab,var(--c)_32%,transparent),color-mix(in_oklab,var(--c)_10%,transparent))] text-[var(--c)] shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_6px_16px_-6px_var(--c)] ring-1 ring-white/10">
                  <I className="size-6" strokeWidth={1.8} aria-hidden />
                  {label === "Running" && running.length > 0 && <span className="bg-destructive absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold text-white">{running.length}</span>}
                </span>
                {label}
              </Link>
            ))}
          </div>
          <section className="grid gap-1.5">
            <button onClick={() => setOrgOpen(!orgOpen)} aria-expanded={orgOpen} className="text-muted-foreground flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wider uppercase">
              Organization
              <span className="text-foreground/80 normal-case tracking-normal">· {orgs.find((o) => o.id === orgId)?.name}</span>
              <ChevronRight className={cn("ml-auto size-3.5 transition-transform", orgOpen && "rotate-90")} aria-hidden />
            </button>
            {orgOpen && <div className="glass sheet-up divide-border/60 divide-y overflow-hidden rounded-2xl">
              {orgs.map((o) => (
                <button key={o.id} onClick={() => (setOrgId(o.id), setMore(false))} className="active:bg-accent/60 flex w-full items-center gap-3 px-3 py-2.5 text-left text-[13px] font-medium">
                  <span className="from-primary flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br to-cyan-500 text-xs font-bold text-white" aria-hidden>
                    {o.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {o.id === orgId && <Check className="text-primary size-4 shrink-0" aria-label="Current" />}
                </button>
              ))}
              <button onClick={() => (setMore(false), setOnboardingOpen(true))} className="text-muted-foreground active:bg-accent/60 flex w-full items-center gap-3 px-3 py-2.5 text-left text-[13px] font-medium">
                <span className="border-foreground/20 flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed">
                  <Plus className="size-4" aria-hidden />
                </span>
                New organization
              </button>
            </div>}
          </section>
          {folders.length > 0 && (
            <section className="grid gap-1.5">
              <h3 className="text-muted-foreground px-1 text-[11px] font-medium tracking-wider uppercase">Files · {folders.length}</h3>
              <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">
                {folders.map((w) => (
                  <Link key={w.id} to={`/?folder=${w.id}&tab=files`} onClick={() => setMore(false)} className="active:bg-accent/60 flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#c084fc]/15 text-[#c084fc]">
                      <FolderGit2 className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
