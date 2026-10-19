import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Bot, Globe, Loader2, Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, useAgents, useChats } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

type Tab = { id: string; url: string; title: string; loading: boolean; ticketId: string | null; agentId: string | null };
type State = {
  state: "off" | "starting" | "downloading" | "ready" | "error";
  message: string;
  active: string | null;
  tabs: Tab[];
  dialog: { type: string; message: string; default: string } | null;
  downloads: { id: string; tab: string; name: string; url: string }[];
};
type Mod = "Alt" | "Control" | "Meta" | "Shift";
type Input =
  | { t: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right"; clicks?: number; mods?: Mod[] }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number; mods?: Mod[] }
  | { t: "key"; down: boolean; key: string; mods?: Mod[] }
  | { t: "text"; text: string };
/** Modifier state of a DOM event, sent with every key and mouse event so the page sees ⌘-click, ⇧-select, ⌘A. */
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): Mod[] =>
  (["Alt", "Control", "Meta", "Shift"] as const).filter((m) => e[`${m === "Control" ? "ctrl" : m.toLowerCase()}Key` as "altKey"]);

const QUICK = [
  { name: "Gmail", url: "https://mail.google.com/" },
  { name: "Slack", url: "https://app.slack.com/" },
  { name: "Calendar", url: "https://calendar.google.com/" },
  { name: "Linear", url: "https://linear.app/" },
  { name: "GitHub", url: "https://github.com/" },
];
const BUTTONS = ["left", "middle", "right"] as const;

/** "gmail.com" → https://gmail.com, anything that isn't a host or URL → a search. */
const toUrl = (s: string) => {
  const v = s.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(v) || /^localhost(:\d+)?(\/\S*)?$/.test(v)) return `${/^localhost/.test(v) ? "http" : "https"}://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
};

// The tab is a Chromium page on the server: frames stream in over SSE (the screencast), and this page sends the
// mouse and keyboard back. Works the same in the desktop app, a browser, or on the phone.
export function BrowserPage() {
  const org = useOrg();
  const qc = useQueryClient();
  const { data: agents = [] } = useAgents(org.id);
  const { data: chats = [] } = useChats(org.id);
  const { data } = useQuery({ queryKey: ["browser"], queryFn: () => api.get<State>("/browser"), refetchInterval: 2000 });
  const [params, setParams] = useSearchParams();
  const bar = useRef<HTMLInputElement>(null);
  const [addr, setAddr] = useState<string | null>(null); // null = show the active tab's URL
  const tabs = data?.tabs ?? [];
  const active = tabs.find((t) => t.id === data?.active) ?? null;
  const ready = data?.state === "ready";

  const refresh = () => qc.invalidateQueries({ queryKey: ["browser"] });
  const view = (v: { active?: string | null; w?: number; h?: number; dpr?: number }) => api.post<State>("/browser/view", v, true).then((s) => qc.setQueryData(["browser"], s), () => {});
  const open = (url: string) => api.post<Tab>("/browser/tabs", { url }, true).then(refresh);
  const close = (id: string) => api.del(`/browser/tabs/${id}`).then(refresh);
  const go = (to: string) => active && api.post(`/browser/tabs/${active.id}/go`, { to }, true).catch(() => {});
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addr?.trim()) return;
    const url = toUrl(addr);
    void (active ? go(url) : open(url));
    setAddr(null);
  };

  // ?tab=… (links in agent comments) picks the tab once.
  const want = params.get("tab");
  useEffect(() => {
    if (want && ready && tabs.some((t) => t.id === want)) {
      void view({ active: want });
      setParams({}, { replace: true });
    }
  }, [want, ready, tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nothing picked yet: show the most recent tab.
  useEffect(() => {
    if (ready && !data?.active && tabs.length && !want) void view({ active: tabs[tabs.length - 1]!.id });
  }, [ready, data?.active, tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <button type="button" aria-label="Inspect (DevTools)" title="Inspect (DevTools)" disabled={!active} onClick={() => active && void api.post(`/browser/tabs/${active.id}/devtools`, {}, true).then(refresh, (e: Error) => toast.error(e.message))} className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex size-7 items-center justify-center rounded-lg disabled:opacity-40">
          <SquareTerminal className="size-4" aria-hidden />
        </button>
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

      {/* Pages can't save files on their own: each download waits here for a yes. */}
      {data?.downloads.map((d) => (
        <div key={d.id} className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate" title={d.url}>
            {tabs.find((t) => t.id === d.tab)?.title || "A page"} wants to download <span className="font-medium">{d.name}</span>
          </span>
          <Button size="sm" variant="outline" className="h-6 text-[12px]" onClick={() => void api.post(`/browser/downloads/${d.id}`, { save: false }, true).finally(refresh)}>
            Discard
          </Button>
          <Button size="sm" className="h-6 text-[12px]" onClick={() => void api.post<{ path: string }>(`/browser/downloads/${d.id}`, { save: true }, true).then((r) => toast.success(`Saved to ${r.path}`)).finally(refresh)}>
            Save to Downloads
          </Button>
        </div>
      ))}

      <div className="relative min-h-0 flex-1">
        {active && ready ? (
          <Screen key={active.id} tab={active.id} onState={refresh} onAddressBar={() => bar.current?.focus()} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            {data && !ready ? (
              <Status state={data} />
            ) : (
              <>
                <p className="text-muted-foreground text-[13px]">Sign in once: tabs stay signed in after you quit Zippy.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {QUICK.map((q) => (
                    <button key={q.url} onClick={() => void open(q.url)} className="bg-card hover:border-primary/40 rounded-xl border px-4 py-2 text-[13px] font-medium">
                      {q.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {active && data?.dialog && <PageDialog tab={active.id} dialog={data.dialog} onDone={refresh} />}
      </div>
    </div>
  );
}

function Status({ state }: { state: State }) {
  const qc = useQueryClient();
  // Opening this page starts the browser (first run may download Chrome for Testing).
  useEffect(() => {
    if (state.state === "off") void api.post<State>("/browser/start", {}, true).then((s) => qc.setQueryData(["browser"], s), () => {});
  }, [state.state]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.state === "error")
    return (
      <>
        <p className="text-foreground text-[13px] font-medium">The browser could not start.</p>
        <p className="text-muted-foreground max-w-md text-[12px]">{state.message}</p>
        <Button size="sm" variant="outline" onClick={() => void api.post<State>("/browser/start", {}, true).then((s) => qc.setQueryData(["browser"], s))}>
          Try again
        </Button>
      </>
    );
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-[13px]">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {state.message || "Starting the browser…"}
    </p>
  );
}

/** One tab on screen: frames in, mouse and keyboard out. */
function Screen({ tab, onState, onAddressBar }: { tab: string; onState: () => void; onAddressBar: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const kb = useRef<HTMLTextAreaElement>(null);
  const [waiting, setWaiting] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // Zippy's right-click menu, when the page has none
  const rightAt = useRef({ x: 0, y: 0 });

  // Frames for this tab only (the parent remounts per tab); "state" means tabs or a dialog changed.
  useEffect(() => {
    const es = new EventSource("/api/browser/stream");
    es.addEventListener("frame", (e) => {
      const f = JSON.parse((e as MessageEvent).data) as { tab: string; data: string };
      if (f.tab !== tab || !img.current) return;
      img.current.src = `data:image/jpeg;base64,${f.data}`;
      setWaiting(false);
    });
    es.addEventListener("state", onState);
    es.addEventListener("cursor", (e) => box.current && (box.current.style.cursor = (JSON.parse((e as MessageEvent).data) as { cursor: string }).cursor));
    return () => es.close();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page's viewport is this box: CSS pixels, at this screen's pixel ratio.
  useEffect(() => {
    const el = box.current!;
    let t: ReturnType<typeof setTimeout>;
    const send = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 150) void api.post("/browser/view", { active: tab, w: r.width, h: r.height, dpr: window.devicePixelRatio }, true).catch(() => {});
      }, 120);
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => (clearTimeout(t), ro.disconnect());
  }, [tab]);

  // Input queue: flushed once per frame, in order; mouse moves and wheel deltas coalesce.
  const q = useRef<{ events: Input[]; sending: boolean; raf: number }>({ events: [], sending: false, raf: 0 });
  const flush = () => {
    const s = q.current;
    s.raf = 0;
    if (s.sending || !s.events.length) return;
    const events = s.events.splice(0);
    s.sending = true;
    void api
      .post<{ menu: boolean }>(`/browser/tabs/${tab}/input`, { events }, true)
      .then((r) => r.menu && setMenu(rightAt.current), () => {})
      .finally(() => {
        s.sending = false;
        if (s.events.length) s.raf ||= requestAnimationFrame(flush);
      });
  };
  const send = (e: Input) => {
    const ev = q.current.events;
    const last = ev[ev.length - 1];
    if (e.t === "move" && last?.t === "move") ev[ev.length - 1] = e;
    else if (e.t === "wheel" && last?.t === "wheel") Object.assign(last, { dx: last.dx + e.dx, dy: last.dy + e.dy, x: e.x, y: e.y });
    else ev.push(e);
    q.current.raf ||= requestAnimationFrame(flush);
  };
  const at = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  };

  // Wheel needs a non-passive listener to stop the Zippy page itself from scrolling.
  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1;
      send({ t: "wheel", ...at(e), dx: e.deltaX * k, dy: e.deltaY * k, mods: mods(e) });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keys reach a hidden textarea: shortcuts and plain keys are replayed as key presses; IME and dead-key text
  // arrives as composed text; paste and copy bridge the system clipboard (the headless page has none).
  const onKey = (down: boolean) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === "Process" || e.key === "Dead" || e.key === "Unidentified") return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") return; // command palette
    e.stopPropagation(); // Zippy's own shortcuts stay out of the page
    if (down && mod && e.key.toLowerCase() === "l") return e.preventDefault(), onAddressBar();
    if (mod && e.key.toLowerCase() === "v") return; // the paste event below sends the text
    e.preventDefault();
    send({ t: "key", down, key: e.key, mods: mods(e) });
    if (down && mod && /^[cx]$/i.test(e.key))
      void api.post<{ text: string }>(`/browser/tabs/${tab}/copy`, {}, true).then(({ text }) => void (text && navigator.clipboard.writeText(text)), () => {});
  };

  return (
    <div
      ref={box}
      className="absolute inset-0 overflow-hidden bg-white outline-none select-none"
      onPointerDown={(e) => {
        e.preventDefault();
        setMenu(null);
        kb.current?.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        send({ t: "down", ...at(e), button: BUTTONS[e.button] ?? "left", clicks: Math.min(3, Math.max(1, e.detail)), mods: mods(e) });
      }}
      onPointerMove={(e) => send({ t: "move", ...at(e), mods: mods(e) })}
      onPointerUp={(e) => (e.button === 2 && (rightAt.current = at(e)), send({ t: "up", ...at(e), button: BUTTONS[e.button] ?? "left", clicks: Math.min(3, Math.max(1, e.detail)), mods: mods(e) }))}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu && (
        <div role="menu" className="bg-popover text-popover-foreground absolute z-10 min-w-36 rounded-lg border p-1 text-[13px] shadow-md" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button
            role="menuitem"
            autoFocus
            onKeyDown={(e) => e.key === "Escape" && setMenu(null)}
            onBlur={() => setMenu(null)}
            onClick={() => (setMenu(null), void api.post(`/browser/tabs/${tab}/devtools`, menu, true).then(onState, (e: Error) => toast.error(e.message)))}
            className="hover:bg-accent focus:bg-accent w-full rounded-md px-2 py-1 text-left outline-none"
          >
            Inspect
          </button>
        </div>
      )}
      <img ref={img} alt="" draggable={false} className="pointer-events-none size-full object-fill" />
      {waiting && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" aria-label="Loading page" />
        </div>
      )}
      <textarea
        ref={kb}
        aria-label="Page keyboard input"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="absolute top-0 left-0 size-px resize-none opacity-0"
        onKeyDown={onKey(true)}
        onKeyUp={onKey(false)}
        onCompositionEnd={(e) => (e.data && send({ t: "text", text: e.data }), (e.currentTarget.value = ""))}
        onInput={(e) => {
          const n = e.nativeEvent as InputEvent;
          if (!n.isComposing && n.data && n.inputType === "insertText") send({ t: "text", text: n.data });
          if (!n.isComposing) e.currentTarget.value = "";
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text");
          if (text) send({ t: "text", text });
        }}
      />
    </div>
  );
}

/** The page's alert / confirm / prompt (the page is paused until it's answered). */
function PageDialog({ tab, dialog, onDone }: { tab: string; dialog: NonNullable<State["dialog"]>; onDone: () => void }) {
  const [text, setText] = useState(dialog.default);
  const answer = (accept: boolean) => void api.post(`/browser/tabs/${tab}/dialog`, { accept, text: dialog.type === "prompt" ? text : undefined }, true).finally(onDone);
  return (
    <div className="absolute inset-0 flex items-start justify-center bg-black/30 pt-16">
      <form className="bg-card w-full max-w-sm rounded-xl border p-4 shadow-xl" onSubmit={(e) => (e.preventDefault(), answer(true))}>
        <p className="text-[13px] whitespace-pre-wrap">{dialog.message}</p>
        {dialog.type === "prompt" && <input autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="Answer" className="bg-muted/50 mt-3 h-8 w-full rounded-lg px-3 text-[13px] outline-none" />}
        <div className="mt-4 flex justify-end gap-2">
          {dialog.type !== "alert" && (
            <Button type="button" size="sm" variant="outline" onClick={() => answer(false)}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" autoFocus={dialog.type !== "prompt"}>
            OK
          </Button>
        </div>
      </form>
    </div>
  );
}
