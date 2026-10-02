import { Monitor, Moon, Sun } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import { flushSync } from "react-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Circular reveal from (x, y) via View Transitions; instant swap if unsupported or reduced motion.
export function useThemeSwitch() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const set = (next: "light" | "dark" | "system", x = innerWidth / 2, y = innerHeight / 2) => {
    if (next === theme) return;
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return setTheme(next);
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(() => flushSync(() => setTheme(next))).ready.then(() =>
      document.documentElement.animate(
        { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 550, easing: "cubic-bezier(0.65, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
      ),
    );
  };
  return { theme, dark, set, toggle: (x?: number, y?: number) => set(dark ? "light" : "dark", x, y) };
}

const center = (e: React.MouseEvent<HTMLElement>) => {
  const b = e.currentTarget.getBoundingClientRect();
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
};

export function ThemeToggle() {
  const { theme, dark, set, toggle } = useThemeSwitch();
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  return (
    <>
      {/* Collapsed rail: single icon button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={label}
            onClick={(e) => toggle(...center(e))}
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-ring/60 flex h-8 items-center justify-center rounded-md outline-none focus-visible:ring-2 wide:hidden"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={dark ? "moon" : "sun"}
                initial={{ rotate: -90, scale: 0.4, opacity: 0 }}
                animate={{ rotate: 0, scale: 1, opacity: 1 }}
                exit={{ rotate: 90, scale: 0.4, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="flex"
              >
                {dark ? <Moon className="size-4" aria-hidden /> : <Sun className="size-4" aria-hidden />}
              </motion.span>
            </AnimatePresence>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>

      {/* Expanded: label + sliding segmented pill */}
      <div className="hidden h-8 items-center justify-between px-2 wide:flex">
        <span className="text-sidebar-foreground text-[13px] font-medium">Theme</span>
        <div role="radiogroup" aria-label="Theme" className="bg-sidebar-accent/70 relative flex rounded-full border p-0.5">
          {(["light", "system", "dark"] as const).map((t) => {
            const active = t === theme;
            const Icon = { light: Sun, system: Monitor, dark: Moon }[t];
            return (
              <button
                key={t}
                role="radio"
                aria-checked={active}
                aria-label={`${t} theme`}
                onClick={(e) => set(t, ...center(e))}
                className={cn(
                  "focus-visible:ring-ring/60 relative flex size-6 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="theme-thumb"
                    transition={{ type: "spring", stiffness: 500, damping: 34 }}
                    className="bg-background absolute inset-0 rounded-full shadow-sm ring-1 ring-black/5 dark:ring-white/10"
                  />
                )}
                <Icon className="relative size-3.5" aria-hidden />
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
