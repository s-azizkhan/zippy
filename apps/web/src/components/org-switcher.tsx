import { Command as Cmd } from "cmdk";
import { Check, ChevronsUpDown, Search, Settings } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Org } from "@zippy/shared";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOrgs } from "@/lib/api";
import { useUI } from "@/lib/store";
import { cn, isTyping } from "@/lib/utils";

const spring = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;

/** Stable hue per org so each one is recognisable at a glance. */
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function OrgAvatar({ org, className }: { org: Pick<Org, "id" | "name">; className?: string }) {
  const h = hue(org.id);
  return (
    <span
      aria-hidden
      style={{ backgroundImage: `linear-gradient(135deg, oklch(0.68 0.17 ${h}), oklch(0.58 0.19 ${(h + 50) % 360}))` }}
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_2px_6px_-2px_rgb(0_0_0/0.4)]", className)}
    >
      {org.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Switch + announce; shared by the menu, ⌥1–9 and the command palette. */
export function useSwitchOrg() {
  const { orgId, setOrgId } = useUI();
  return (o: Org) => {
    if (o.id === orgId) return;
    setOrgId(o.id);
    toast.success(`Switched to ${o.name}`, { duration: 1600 });
  };
}

export function OrgSwitcher({ org }: { org: Org }) {
  const { data: orgs = [] } = useOrgs();
  const setOnboardingOpen = useUI((s) => s.setOnboardingOpen);
  const switchOrg = useSwitchOrg();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(org.id);

  // ⌥1–9 jumps straight to an org from anywhere. e.code: ⌥ remaps e.key on macOS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^[1-9]$/.exec(e.key)?.[0];
      if (!n || !e.altKey || e.metaKey || e.ctrlKey || isTyping(e)) return;
      const o = orgs[+n - 1];
      if (!o) return;
      e.preventDefault();
      switchOrg(o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orgs, switchOrg]);

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (v) {
      setQ("");
      setHl(org.id);
    }
  };
  const pick = (o: Org) => (setOpen(false), switchOrg(o));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className={cn(
          "group/org border-foreground/[0.07] bg-foreground/[0.03] hover:bg-foreground/[0.06] hover:border-foreground/[0.12] focus-visible:ring-ring/60 relative flex h-10 min-w-0 items-center justify-center gap-2.5 rounded-xl border px-1.5 text-left outline-none transition-[background-color,border-color,transform] duration-200 focus-visible:ring-2 active:scale-[0.98] wide:justify-start",
          open && "bg-foreground/[0.06] border-foreground/[0.12]",
        )}
        aria-label={`Organization: ${org.name}. Switch organization`}
      >
        <span className="relative size-6 shrink-0 [perspective:400px]">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={org.id} className="absolute inset-0" initial={{ rotateX: -90, opacity: 0, scale: 0.8 }} animate={{ rotateX: 0, opacity: 1, scale: 1 }} exit={{ rotateX: 90, opacity: 0, scale: 0.8 }} transition={spring}>
              <OrgAvatar org={org} />
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="hidden min-w-0 flex-1 overflow-hidden leading-tight wide:block">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={org.id} className="block truncate text-[13px] font-semibold" initial={{ y: 10, opacity: 0, filter: "blur(4px)" }} animate={{ y: 0, opacity: 1, filter: "blur(0px)" }} exit={{ y: -10, opacity: 0, filter: "blur(4px)" }} transition={spring}>
              {org.name}
            </motion.span>
          </AnimatePresence>
          <span className="text-muted-foreground block font-mono text-[10px]">
            {orgs.length > 1 ? `${orgs.length} organizations` : "organization"}
          </span>
        </span>
        <motion.span className="hidden wide:block" animate={{ rotate: open ? 180 : 0 }} transition={spring}>
          <ChevronsUpDown className="text-muted-foreground group-hover/org:text-foreground size-3.5 transition-colors" aria-hidden />
        </motion.span>
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={6} className="w-64 gap-0 overflow-hidden rounded-xl p-0">
        <Cmd value={hl} onValueChange={setHl} loop label="Switch organization" className="flex flex-col">
          {/* Input always present: it holds focus so arrows/enter drive the list, and typing filters. */}
          <div className="border-foreground/[0.07] flex items-center gap-2 border-b px-3">
            <Search className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
            <Cmd.Input value={q} onValueChange={setQ} autoFocus placeholder="Switch organization…" className="placeholder:text-muted-foreground h-10 flex-1 bg-transparent text-[13px] outline-none" />
            <kbd className="text-muted-foreground bg-foreground/[0.06] rounded px-1.5 font-mono text-[10px]">esc</kbd>
          </div>
          <Cmd.List className="max-h-72 overflow-y-auto p-1 [scrollbar-width:thin]">
            <Cmd.Empty className="text-muted-foreground py-6 text-center text-[13px]">No organization matches “{q}”</Cmd.Empty>
            {orgs.map((o, i) => {
              const current = o.id === org.id;
              return (
                <Cmd.Item key={o.id} value={o.id} keywords={[o.name, o.linearWorkspace ?? ""]} onSelect={() => pick(o)} className="relative flex h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] outline-none select-none">
                  {hl === o.id && <motion.span layoutId="org-hl" className="bg-foreground/[0.07] ring-foreground/[0.06] absolute inset-0 rounded-lg ring-1" transition={spring} />}
                  <motion.span className="relative flex min-w-0 flex-1 items-center gap-2.5" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring, delay: Math.min(i, 8) * 0.025 }}>
                    <OrgAvatar org={o} className={cn("size-7 transition-transform duration-200", hl === o.id && "scale-105")} />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className={cn("block truncate", current ? "font-semibold" : "font-medium")}>{o.name}</span>
                      <span className="text-muted-foreground block truncate font-mono text-[10px]">{o.linearWorkspace ? `linear · ${o.linearWorkspace}` : `${o.ticketSeq} issues`}</span>
                    </span>
                    {current ? (
                      <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring} className="bg-primary/15 text-primary flex size-5 items-center justify-center rounded-full">
                        <Check className="size-3" strokeWidth={3} aria-label="Current" />
                      </motion.span>
                    ) : (
                      i < 9 && <kbd className="text-muted-foreground bg-foreground/[0.06] rounded px-1.5 font-mono text-[10px]">⌥{i + 1}</kbd>
                    )}
                  </motion.span>
                </Cmd.Item>
              );
            })}
          </Cmd.List>
          <div className="border-foreground/[0.07] grid gap-0.5 border-t p-1">
            <Cmd.Item value="__new" keywords={["new", "create", "add"]} onSelect={() => (setOpen(false), setOnboardingOpen(true))} className="relative flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium outline-none select-none">
              {hl === "__new" && <motion.span layoutId="org-hl" className="bg-foreground/[0.07] absolute inset-0 rounded-lg" transition={spring} />}
              <span className="border-foreground/20 text-muted-foreground relative flex size-7 items-center justify-center rounded-lg border border-dashed">
                <Plus className="size-3.5" aria-hidden />
              </span>
              <span className="relative">New organization</span>
            </Cmd.Item>
            <Cmd.Item value="__settings" keywords={["settings", "preferences"]} onSelect={() => (setOpen(false), navigate("/settings"))} className="text-muted-foreground relative flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium outline-none select-none">
              {hl === "__settings" && <motion.span layoutId="org-hl" className="bg-foreground/[0.07] absolute inset-0 rounded-lg" transition={spring} />}
              <span className="relative flex size-7 items-center justify-center">
                <Settings className="size-4" aria-hidden />
              </span>
              <span className="relative">Settings</span>
            </Cmd.Item>
          </div>
        </Cmd>
      </PopoverContent>
    </Popover>
  );
}
