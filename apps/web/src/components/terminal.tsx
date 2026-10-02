import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { Comment, ToolPayload } from "@zippy/shared";

const nl = (s: string) => s.replace(/\r?\n/g, "\r\n");

/** Read-only terminal replaying agent tool calls and their streamed output. */
export function Terminal({ comments }: { comments: Comment[] }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(null);
  const written = useRef(new Map<string, number>());

  useEffect(() => {
    const el = host.current!;
    const seen = written.current;
    const t = new XTerm({
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      convertEol: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 5000,
      theme: { background: "#0f0f10", foreground: "#c9cacd" },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    fit.fit();
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);
    term.current = t;
    return () => {
      ro.disconnect();
      t.dispose();
      term.current = null;
      seen.clear();
    };
  }, []);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    for (const c of comments) {
      if (c.kind !== "tool") continue;
      const p = c.payload as ToolPayload;
      const done = written.current.get(c.id);
      if (done === undefined) t.write(`\x1b[2m$ ${nl(p.title)}\x1b[0m\r\n`);
      const out = p.output ?? "";
      if (out.length > (done ?? 0)) t.write(nl(out.slice(done ?? 0)) + (done === undefined ? "\r\n" : ""));
      written.current.set(c.id, Math.max(out.length, done ?? 0));
    }
  }, [comments]);

  return <div ref={host} role="log" aria-label="Agent terminal output" className="h-[60vh] min-h-64 overflow-hidden rounded-md bg-[#0f0f10] p-2" />;
}
