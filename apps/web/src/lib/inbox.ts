import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { InboxItem } from "@zippy/shared";
import { useInbox } from "@/lib/api";

export const itemKey = (i: InboxItem) => i.commentId ?? `${i.kind}:${i.ticket.id}`;

const pad = (n: number) => String(n).padStart(2, "0");
/** Local calendar day, so "today" flips at the user's midnight. */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shiftDay = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y!, m! - 1, d! + n, 12));
};

export const SNOOZES: { id: string; label: string; key: string; until: () => Date }[] = [
  { id: "1h", label: "In 1 hour", key: "S", until: () => new Date(Date.now() + 3600_000) },
  { id: "3h", label: "In 3 hours", key: "", until: () => new Date(Date.now() + 3 * 3600_000) },
  { id: "tomorrow", label: "Tomorrow 9:00", key: "⇧S", until: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
  { id: "monday", label: "Next Monday", key: "", until: () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d; } },
];

// ponytail: all of this lives in localStorage. Move to the server when a second device or person needs the same inbox.
type State = {
  seen: Record<string, number>; // item key → first time it was on screen
  snoozed: Record<string, string>; // item key → ISO when it comes back
  cleared: Record<string, number>; // local day → items acted on
  focus: boolean; // one-card triage view
  markSeen: (keys: string[]) => void;
  snooze: (key: string, until: Date | null) => void;
  bump: () => void;
  setFocus: (focus: boolean) => void;
};

export const useInboxState = create<State>()(
  persist(
    (set) => ({
      seen: {},
      snoozed: {},
      cleared: {},
      focus: false,
      markSeen: (keys) =>
        set((s) => {
          const fresh = keys.filter((k) => !s.seen[k]);
          if (!fresh.length) return s;
          const now = Date.now();
          // Keep the map bounded: newest 600 entries win.
          const entries = [...Object.entries(s.seen), ...fresh.map((k) => [k, now] as const)].sort((a, b) => b[1] - a[1]).slice(0, 600);
          return { seen: Object.fromEntries(entries) };
        }),
      snooze: (key, until) =>
        set((s) => {
          const snoozed = { ...s.snoozed };
          const seen = { ...s.seen };
          if (until) snoozed[key] = until.toISOString();
          else delete snoozed[key];
          delete seen[key]; // comes back as unread
          return { snoozed, seen };
        }),
      bump: () =>
        set((s) => {
          const day = localDay();
          // Drop days older than 60 so the streak math stays cheap.
          const cleared = Object.fromEntries(Object.entries(s.cleared).filter(([d]) => d >= shiftDay(day, -60)));
          return { cleared: { ...cleared, [day]: (cleared[day] ?? 0) + 1 } };
        }),
      setFocus: (focus) => set({ focus }),
    }),
    { name: "zippy-inbox" },
  ),
);

/** Consecutive days (ending today or yesterday) with at least one cleared item. */
export function streakOf(cleared: Record<string, number>) {
  let day = localDay();
  if (!cleared[day]) day = shiftDay(day, -1);
  let n = 0;
  while (cleared[day]) (n++, (day = shiftDay(day, -1)));
  return n;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
/** Who waited longest on the most important ticket comes first. */
export const byUrgency = (a: InboxItem, b: InboxItem) =>
  (PRIORITY_RANK[a.ticket.priority] ?? 4) - (PRIORITY_RANK[b.ticket.priority] ?? 4) || a.createdAt.localeCompare(b.createdAt);

/** Inbox split into live vs snoozed, plus the numbers the badge and header show. */
export function useInboxView(orgId?: string) {
  const { data = [], isLoading } = useInbox(orgId);
  const { seen, snoozed, cleared } = useInboxState();
  const now = Date.now();
  const items: InboxItem[] = [];
  const later: InboxItem[] = [];
  for (const i of data) {
    const until = snoozed[itemKey(i)];
    (until && Date.parse(until) > now ? later : items).push(i);
  }
  items.sort(byUrgency);
  later.sort((a, b) => snoozed[itemKey(a)]!.localeCompare(snoozed[itemKey(b)]!));
  const unread = items.filter((i) => !seen[itemKey(i)]).length;
  return { items, later, unread, isLoading, todayCleared: cleared[localDay()] ?? 0, streak: streakOf(cleared) };
}
