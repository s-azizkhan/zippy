import { ArrowLeftIcon as ArrowLeft } from "@/components/ui/arrow-left";
import { HomeIcon as Home } from "@/components/ui/home";
import { RefreshCWIcon as RefreshCw } from "@/components/ui/refresh-cw";
import { SettingsIcon as Settings } from "@/components/ui/settings";
import { isRouteErrorResponse, useNavigate, useParams, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ErrorCode = 400 | 401 | 403 | 404 | 408 | 409 | 410 | 413 | 429 | 500 | 502 | 503 | 504 | "offline" | "crash" | "stale";

type Action = "home" | "retry" | "back" | "settings";
type Tone = "lost" | "locked" | "slow" | "down" | "oops";

const COPY: Record<ErrorCode, { label: string; title: string; text: string; tone: Tone; action: Action }> = {
  400: { label: "400", title: "That request made no sense", text: "Something in it was malformed. Go back and try again.", tone: "oops", action: "back" },
  401: { label: "401", title: "Sign in to continue", text: "Your session is gone or Claude is logged out. Log in again and retry.", tone: "locked", action: "settings" },
  403: { label: "403", title: "Not your door", text: "You don't have access to this. Ask an org admin if it should be yours.", tone: "locked", action: "home" },
  404: { label: "404", title: "Page not found", text: "This page was moved, merged, or never existed. Even Zippers get lost.", tone: "lost", action: "home" },
  408: { label: "408", title: "That took too long", text: "The request timed out before it finished. Try again.", tone: "slow", action: "retry" },
  409: { label: "409", title: "Someone got there first", text: "This changed while you were looking at it. Reload to see the latest.", tone: "oops", action: "retry" },
  410: { label: "410", title: "Gone for good", text: "This was deleted and isn't coming back.", tone: "lost", action: "home" },
  413: { label: "413", title: "Too big to carry", text: "That payload is over the limit. Trim it and try again.", tone: "oops", action: "back" },
  429: { label: "429", title: "Easy there, speedy", text: "Too many requests. Take a breath and retry in a moment.", tone: "slow", action: "retry" },
  500: { label: "500", title: "Zippy tripped", text: "Something broke on our side. It's logged; retrying often works.", tone: "oops", action: "retry" },
  502: { label: "502", title: "Bad gateway", text: "The server answered with nonsense. Try again in a moment.", tone: "down", action: "retry" },
  503: { label: "503", title: "Server is out", text: "The Zippy server isn't reachable. Check that it's running, then retry.", tone: "down", action: "retry" },
  504: { label: "504", title: "Server stopped answering", text: "The upstream took too long to respond. Try again.", tone: "slow", action: "retry" },
  offline: { label: "offline", title: "You're offline", text: "No network connection. Zippy picks up where it left off once you're back.", tone: "down", action: "retry" },
  crash: { label: "crash", title: "This view crashed", text: "A bug took this screen down. Reload to recover; your tickets are safe.", tone: "oops", action: "retry" },
  stale: { label: "update", title: "Zippy was updated", text: "A newer version is live and this tab is out of date. Reload to catch up.", tone: "slow", action: "retry" },
};

// Mark + glow tweak per tone: tilt, dim, desaturate.
const TONE: Record<Tone, string> = {
  lost: "[animation:err-wander_5s_ease-in-out_infinite]",
  locked: "grayscale-[.5] [animation:err-bob_3.2s_ease-in-out_infinite]",
  slow: "[animation:err-sway_4s_ease-in-out_infinite]",
  down: "grayscale opacity-60 [animation:err-bob_4s_ease-in-out_infinite]",
  oops: "[animation:err-wobble_.9s_ease-in-out_2] -rotate-6",
};

/** Maps anything thrown (route response, fetch failure, ApiError, render error) to a variant. */
const byStatus = (n: number): ErrorCode => (n in COPY ? (n as ErrorCode) : n >= 500 ? 500 : 400);

export function errorCode(e: unknown): ErrorCode {
  const status = isRouteErrorResponse(e) ? e.status : (e as { status?: number })?.status;
  if (status) return byStatus(status);
  const msg = String((e as Error)?.message ?? e);
  if (/dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(msg)) return "stale";
  if (!navigator.onLine) return "offline";
  if (e instanceof TypeError && /fetch|network|load failed/i.test(msg)) return 503;
  return "crash";
}

export function ErrorPage({ code = 404, title, text, error, compact, onRetry }: { code?: ErrorCode; title?: string; text?: string; error?: unknown; compact?: boolean; onRetry?: () => void }) {
  const c = COPY[code];
  const navigate = useNavigate();
  const detail = error instanceof Error ? error.stack ?? error.message : error ? String(error) : "";
  const retry = onRetry ?? (() => location.reload());
  const primary = {
    home: { icon: Home, label: "Back to issues", onClick: () => navigate("/") },
    settings: { icon: Settings, label: "Open settings", onClick: () => navigate("/settings") },
    retry: { icon: RefreshCw, label: code === "stale" ? "Reload" : "Try again", onClick: retry },
    back: { icon: ArrowLeft, label: "Go back", onClick: () => navigate(-1) },
  }[c.action];
  const PIcon = primary.icon;

  return (
    <div role="alert" className={cn("relative grid place-content-center justify-items-center gap-3 overflow-hidden px-6 text-center", compact ? "flex-1 py-16" : "min-h-dvh bg-background text-foreground")}>
      <style>{`
        @keyframes err-bob{50%{transform:translateY(-6px)}}
        @keyframes err-sway{50%{transform:rotate(7deg) translateY(-3px)}}
        @keyframes err-wobble{25%{transform:rotate(-12deg)}75%{transform:rotate(4deg)}}
        @keyframes err-wander{0%,100%{transform:translateX(-10px) rotate(-6deg)}50%{transform:translateX(10px) rotate(6deg)}}
        @media (prefers-reduced-motion:reduce){.err-mark{animation:none!important}}
      `}</style>
      <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 size-[28rem] -translate-x-1/2 -translate-y-[60%] rounded-full bg-primary/15 blur-3xl" />
      <div className="relative grid justify-items-center gap-3">
        <img src="/favicon.svg" alt="" className={cn("err-mark size-20 drop-shadow-[0_8px_22px_rgba(94,106,210,.45)]", TONE[c.tone])} />
        <div className="text-primary font-mono text-xs font-medium tracking-[0.2em] uppercase">{c.label}</div>
        <h1 className="text-3xl font-semibold tracking-[-0.04em] text-balance">{title ?? c.title}</h1>
        <p className="text-muted-foreground max-w-sm text-sm text-pretty">{text ?? c.text}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button onClick={primary.onClick}>
            <PIcon /> {primary.label}
          </Button>
          {c.action !== "back" && (
            <Button variant="outline" onClick={() => navigate(-1)}>
              <ArrowLeft /> Go back
            </Button>
          )}
        </div>
        {detail && (
          <details className="mt-4 max-w-xl text-left">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-center text-xs">Technical details</summary>
            <pre className="bg-muted mt-2 max-h-40 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">{detail}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/** Router errorElement: render errors, thrown responses, failed loaders. */
export function RouteError() {
  const e = useRouteError();
  if (!isRouteErrorResponse(e)) console.error(e);
  return <ErrorPage code={errorCode(e)} error={isRouteErrorResponse(e) ? undefined : e} />;
}

/** Dev preview at /error/:code (404, 500, offline, crash, ...). */
export function ErrorPreview() {
  const { code = "404" } = useParams();
  return <ErrorPage code={(Number(code) || code) as ErrorCode} error={code === "crash" ? new Error("Example crash\n  at Preview (error-page.tsx)") : undefined} />;
}
