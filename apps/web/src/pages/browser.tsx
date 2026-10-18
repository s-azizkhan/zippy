import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Bot, Globe, Loader2, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, useAgents, useChats } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";

type Tab = { id: string; url: string; title: string; loading: boolean; ticketId: string | null; agentId: string | null };
type State = { connected: boolean; active: string | null; tabs: Tab[] };

const QUICK = [
  { name: "Gmail", url: "https://mail.google.com/" },
  { name: "Slack", url: "https://app.slack.com/" },
  { name: "Calendar", url: "https://calendar.google.com/" },
  { name: "Linear", url: "https://linear.app/" },
  { name: "GitHub", url: "https://github.com/" },
];

/** "gmail.com" → https://gmail.com, anything that isn't a host or URL → a search. */
const toUrl = (s: string) => {
  const v = s.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(v) || /^localhost(:\d+)?(\/\S*)?$/.test(v)) return `${/^localhost/.test(v) ? "http" : "https"}://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
};

// Tabs are native webviews drawn by the desktop app on top of this page, inside the placeholder below.
// This page only tells the app where that placeholder is and which tab to show; HTML can't draw over a tab.
export function BrowserPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const { data: agents = [] } = useAgents(org.id);
  const { data: chats = [] } = useChats(org.id);
  const { data } = useQuery({ queryKey: ["browser"], queryFn: () => api.get<State>("/browser"), refetchInterval: 1500 });
  const [params, setParams] = useSearchParams();
  const overlay = useUI((s) => s.paletteOpen || s.newTicketOpen);
  const slot = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLInputElement>(null);
  const [addr, setAddr] = useState<string | null>(null); // null = show the active tab's URL
  const tabs = data?.tabs ?? [];
  const active = tabs.find((t) => t.id === data?.active) ?? null;

  const view = (v: { active?: string | null; visible?: boolean; bounds?: { x: number; y: number; w: number; h: number } }) =>
    api.post<State>("/browser/view", v, true).then((s) => qc.setQueryData(["browser"], s), () => {});

  // ?tab=… (links in agent comments) picks the tab once.
  const want = params.get("tab");
  useEffect(() => {
    if (want && data?.connected && tabs.some((t) => t.id === want)) {
      void view({ active: want });
      setParams({}, { replace: true });
    }
  }, [want, data?.connected, tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the placeholder's position and size; hide every tab when leaving the page or while an overlay is open.
  const connected = !!data?.connected;
  const shown = connected && !overlay && !!active;
  useLayoutEffect(() => {
    const el = slot.current;
    if (!connected || !el) return;
    let frame = 0;
    const send = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) void view({ visible: shown, bounds: { x: r.left, y: r.top, w: r.width, h: r.height } });
      });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener("resize", send);
    return () => (cancelAnimationFrame(frame), ro.disconnect(), window.removeEventListener("resize", send));
  }, [connected, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void view({ visible: false }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (url: string) => api.post<Tab>("/browser/tabs", { url }, true).then(() => qc.invalidateQueries({ queryKey: ["browser"] }));
  const close = (id: string) => api.del(`/browser/tabs/${id}`).then(() => qc.invalidateQueries({ queryKey: ["browser"] }));
  const go = (to: string) => active && api.post(`/browser/tabs/${active.id}/go`, { to }, true);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addr?.trim()) return;
    const url = toUrl(addr);
    void (active ? go(url) : open(url));
    setAddr(null);
  };

  if (data && !connected)
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-[13px]">
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="text-foreground font-medium">The browser runs in the Zippy desktop app.</p>
        <p>Open Zippy on your Mac to browse with your accounts signed in, and to let Zippers use the web.</p>
      </div>
    );

  const agentOf = (t: Tab) => (t.agentId ? agents.find((a) => a.id === t.agentId) : undefined);
  const owner = active && agentOf(active);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b px-2 pt-2 [scrollbar-width:none]" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => {
          const a = agentOf(t);
          return (
            <div key={t.id} role="tab" aria-selected={t.id === active?.id} className={cn("group flex h-8 max-w-[220px] min-w-[120px] shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 text-[12px]", t.id === active?.id ? "bg-background text-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground border-transparent")}>
              <button className="flex min-w-0 flex-1 items-center gap-1.5 outline-none" onClick={() => (setAddr(null), void view({ active: t.id }))} title={`${t.title}\n${t.url}`}>
                {t.loading ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : a ? <Bot className="size-3.5 shrink-0 text-emerald-500" aria-label={`@${a.handle}'s tab`} /> : <Globe className="size-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{t.title || t.url}</span>
              </button>
              <button aria-label={`Close ${t.title}`} onClick={() => void close(t.id)} className="hover:bg-foreground/10 rounded p-0.5 opacity-60 group-hover:opacity-100">
                <X className="size-3" aria-hidden />
              </button>
            </div>
          );
        })}
        <button aria-label="New tab" onClick={() => (void view({ active: null }), setAddr(""), bar.current?.focus())} className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex size-7 shrink-0 items-center justify-center rounded-lg">
          <Plus className="size-4" aria-hidden />
        </button>
      </div>

      <form onSubmit={submit} className="flex items-center gap-1 border-b px-2 py-1.5">
        {[
          { label: "Back", icon: ArrowLeft, to: "back" },
          { label: "Forward", icon: ArrowRight, to: "forward" },
          { label: "Reload", icon: RotateCw, to: "reload" },
        ].map(({ label, icon: Icon, to }) => (
          <button key={to} type="button" aria-label={label} disabled={!active} onClick={() => void go(to)} className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex size-7 items-center justify-center rounded-lg disabled:opacity-40">
            <Icon className="size-4" aria-hidden />
          </button>
        ))}
        <input
          ref={bar}
          value={addr ?? active?.url ?? ""}
          onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => e.key === "Escape" && (setAddr(null), e.currentTarget.blur())}
          placeholder="Search or enter address"
          aria-label="Address"
          className="bg-muted/50 focus:bg-background focus:ring-ring/50 h-8 min-w-0 flex-1 rounded-lg px-3 text-[13px] outline-none focus:ring-2"
        />
      </form>

      {owner && active && (
        <p className="border-b bg-emerald-500/10 px-3 py-1 text-[12px] text-emerald-600 dark:text-emerald-400">
          @{owner.handle} opened this tab
          {active.ticketId && (
            <>
              {" for "}
              <Link to={chats.some((c) => c.id === active.ticketId) ? `/chat/${active.ticketId}` : `/t/${active.ticketId}`} className="underline underline-offset-2">
                {chats.some((c) => c.id === active.ticketId) ? "its chat" : "its ticket"}
              </Link>
            </>
          )}
          . Clicking around here can confuse it.
        </p>
      )}

      <div ref={slot} className="relative min-h-0 flex-1">
        {!active && (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
            <p className="text-muted-foreground text-[13px]">Sign in once: tabs stay signed in after you quit Zippy.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {QUICK.map((q) => (
                <button key={q.url} onClick={() => void open(q.url)} className="bg-card hover:border-primary/40 rounded-xl border px-4 py-2 text-[13px] font-medium">
                  {q.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
