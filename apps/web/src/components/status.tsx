import type { Agent, PRIORITIES, TicketStatus } from "@zippy/shared";
import { AgentFace } from "@/components/agent-face";
import { cn } from "@/lib/utils";

type Priority = (typeof PRIORITIES)[number];

export const STATUS: Record<TicketStatus, { label: string; color: string; fill: number }> = {
  backlog: { label: "Backlog", color: "var(--muted-foreground)", fill: -1 },
  todo: { label: "Todo", color: "var(--muted-foreground)", fill: 0 },
  in_progress: { label: "In Progress", color: "#f2c94c", fill: 0.5 },
  needs_input: { label: "Needs Input", color: "#f2994a", fill: 0.5 },
  in_review: { label: "In Review", color: "#4cb782", fill: 0.75 },
  done: { label: "Done", color: "#5e6ad2", fill: 1 },
  blocked: { label: "Blocked", color: "#eb5757", fill: 0.25 },
  canceled: { label: "Canceled", color: "var(--muted-foreground)", fill: 1 },
};

export const STATUS_ORDER: TicketStatus[] = ["needs_input", "in_review", "in_progress", "blocked", "todo", "backlog", "done", "canceled"];

export const PRIORITY_LABEL: Record<Priority, string> = { none: "No priority", urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

/** Linear-style priority glyph: dashes, signal bars, or the urgent square. */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  if (priority === "none")
    return (
      <svg viewBox="0 0 16 16" className={cn(cls, "text-muted-foreground")} aria-hidden>
        {[2.5, 7, 11.5].map((x) => (
          <rect key={x} x={x} y="7.25" width="2.5" height="1.5" rx="0.5" fill="currentColor" />
        ))}
      </svg>
    );
  if (priority === "urgent")
    return (
      <svg viewBox="0 0 16 16" className={cn(cls, "text-[#f2994a]")} aria-hidden>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M8 4.5v4.5M8 11v.5" stroke="var(--background)" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    );
  const on = { high: 3, medium: 2, low: 1 }[priority];
  return (
    <svg viewBox="0 0 16 16" className={cls} aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4.5} y={10 - i * 3.5} width="3" height={4 + i * 3.5} rx="1" fill="currentColor" className={i < on ? "text-foreground/80" : "text-muted-foreground/35"} />
      ))}
    </svg>
  );
}

export function LabelDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

/** Linear-style ring icon; fill shows progress. Decorative: pair with a text label. */
export function StatusIcon({ status, className }: { status: TicketStatus; className?: string }) {
  const { color, fill } = STATUS[status];
  const r = 5.5;
  const c = 2 * Math.PI * 3;
  return (
    <svg viewBox="0 0 14 14" className={cn("size-3.5 shrink-0", className)} aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray={fill < 0 ? "2 2" : undefined} />
      {fill > 0 && fill < 1 && (
        <circle cx="7" cy="7" r="3" fill="none" stroke={color} strokeWidth="6" strokeDasharray={`${c * fill} ${c}`} transform="rotate(-90 7 7)" />
      )}
      {fill === 1 && <circle cx="7" cy="7" r={r} fill={color} />}
      {status === "done" && <path className="draw" d="M4.5 7.2l1.7 1.6 3.3-3.4" fill="none" stroke="white" strokeWidth="1.4" />}
      {status === "canceled" && <path className="draw" d="M5 5l4 4M9 5l-4 4" stroke="white" strokeWidth="1.4" />}
    </svg>
  );
}

export function AgentAvatar({ agent, className, running, track }: { agent?: (Pick<Agent, "name" | "color"> & { id?: string }) | null; className?: string; running?: boolean; track?: boolean }) {
  if (!agent) return <span className={cn("bg-muted inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium", className)} aria-hidden>?</span>;
  return (
    <span className={cn("relative inline-flex size-5 shrink-0", className)} aria-hidden>
      <AgentFace seed={agent.id ?? agent.name} color={agent.color} track={track} state={running ? "working" : undefined} className="size-full" />
      {running && <span className="absolute -right-0.5 -bottom-0.5 size-2 animate-pulse rounded-full bg-green-500 ring-2 ring-[var(--background)]" />}
    </span>
  );
}

const PEOPLE_COLORS = ["#5e6ad2", "#26b5ce", "#4cb782", "#f2994a", "#eb5757", "#bb87fc", "#e0b03b"];

/** Human avatar: initials on a color derived from the name. No name = you. */
export function UserAvatar({ name, className }: { name?: string; className?: string }) {
  const initials = name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "Y";
  const color = name ? PEOPLE_COLORS[[...name].reduce((h, ch) => h + ch.charCodeAt(0), 0) % PEOPLE_COLORS.length] : undefined;
  return (
    <span
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold", !name && "bg-foreground text-background", name && "text-white", className)}
      style={color ? { background: color } : undefined}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function SourceIcon({ linear, className }: { linear: boolean; className?: string }) {
  const label = linear ? "Linear" : "Zippy";
  return (
    <span title={`From ${label}`} className={cn("inline-flex shrink-0", className)}>
      {linear ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-3.5" aria-hidden>
          <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
        </svg>
      ) : (
        <img src="/favicon.svg" alt="" className="size-3.5" />
      )}
      <span className="sr-only">From {label}</span>
    </span>
  );
}
