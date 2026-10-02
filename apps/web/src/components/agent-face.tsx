import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";

/** Two-tone body palettes (top, bottom). `color` on an agent holds one of these ids. */
export const PALETTES = {
  "bubblegum-sky": ["#8bd4ff", "#ff51bf"], "pink-lemonade": ["#ff26a8", "#fff78a"], "orchid-peach": ["#e771ff", "#ffd87c"],
  "coral-mint": ["#beffe8", "#ff797b"], "lime-lagoon": ["#b4ffa4", "#26dfff"], "arctic-blue": ["#97fff3", "#0084ff"],
  "solar-flare": ["#ecca5c", "#fe3c3f"], "violet-ember": ["#ff5c43", "#6262ff"], "deep-tide": ["#003d60", "#32fffc"],
  "coral-current": ["#26e2ff", "#ff6666"], "golden-hour": ["#ffcd4f", "#fde5ba"], "tangerine-cobalt": ["#ffad32", "#4169ff"],
  "electric-grove": ["#b4ff32", "#008d58"], "flamingo-jade": ["#ff4f9a", "#36edaa"], "cherry-pop": ["#ff69db", "#d51c46"],
  "turquoise-cherry": ["#37f0db", "#ff4f64"], "ultraviolet-tide": ["#7516cf", "#00e8d1"],
} as const;
export const PALETTE_IDS = Object.keys(PALETTES) as (keyof typeof PALETTES)[];

/** Seeded PRNG: same seed, same face. */
function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (const ch of seed) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

export const FACE_PARTS = { body: 5, eye: 8, mouth: 7, gear: 9 } as const;
export type FacePart = keyof typeof FACE_PARTS;
const PART_KEYS = Object.keys(FACE_PARTS) as FacePart[];

/** `color` = `palette~BEMG` (one digit each: body, eyes, mouth, gear). Missing bits derive from the seed. */
export function faceOf(color: string, seed: string) {
  const [pal = "", digits = ""] = color.split("~");
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % PALETTE_IDS.length;
  const id = pal in PALETTES ? (pal as keyof typeof PALETTES) : PALETTE_IDS[h]!;
  const r = rng(seed + "face");
  const parts = Object.fromEntries(PART_KEYS.map((k, i) => [k, Number(digits[i] ?? r(FACE_PARTS[k])) % FACE_PARTS[k]])) as Record<FacePart, number>;
  return { id, a: PALETTES[id][0], b: PALETTES[id][1], ...parts, blush: r(3) === 0 };
}
export const paletteOf = (color: string, seed: string) => faceOf(color, seed);
export const encodeFace = (f: { id: string } & Record<FacePart, number>) => `${f.id}~${PART_KEYS.map((k) => f[k]).join("")}`;
export const randomFace = () => {
  const id = PALETTE_IDS[Math.floor(Math.random() * PALETTE_IDS.length)]!;
  return encodeFace({ id, ...(Object.fromEntries(PART_KEYS.map((k) => [k, Math.floor(Math.random() * FACE_PARTS[k])])) as Record<FacePart, number>) });
};

// One pointer listener drives every tracking face on the page.
const tracked = new Set<SVGSVGElement>();
let frame = 0;
let pointer: { x: number; y: number } | null = null;

function look() {
  frame = 0;
  for (const el of tracked) {
    const r = el.getBoundingClientRect();
    let x = 0, y = 0;
    if (pointer) {
      x = (pointer.x - r.left - r.width / 2) / Math.max(80, r.width / 2);
      y = -(pointer.y - r.top - r.height / 2) / Math.max(80, r.height / 2);
    }
    const len = Math.max(1, Math.hypot(x, y));
    el.style.setProperty("--gx", String(x / len));
    el.style.setProperty("--gy", String(y / len));
  }
}
const schedule = () => (frame ||= requestAnimationFrame(look));
const move = (e: PointerEvent) => {
  if (e.pointerType === "touch") return;
  pointer = { x: e.clientX, y: e.clientY };
  schedule();
};
const leave = () => ((pointer = null), schedule());

function track(el: SVGSVGElement) {
  if (matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)").matches) return;
  if (!tracked.size) {
    addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
  }
  tracked.add(el);
  return () => {
    tracked.delete(el);
    if (!tracked.size) {
      removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    }
  };
}

const INK = "#172023";
const W = "rgba(255,255,255,.94)";
const line = { fill: "none", stroke: INK, strokeWidth: 1.4, strokeLinecap: "round" as const };

const BODIES = [
  "M15.5 49.5a34.5 34.5 0 0 1 69 0V79a5.5 5.5 0 0 1-5.5 5.5H21A5.5 5.5 0 0 1 15.5 79z",
  "M50 16c19 0 34.5 14 34.5 33 0 21-13 35.5-34.5 35.5S15.5 70 15.5 49C15.5 30 31 16 50 16z",
  "M22 45a28 28 0 0 1 56 0V79a5.5 5.5 0 0 1-5.5 5.5h-45A5.5 5.5 0 0 1 22 79z",
  "M15.5 41a24 24 0 0 1 24-24h21a24 24 0 0 1 24 24v20a24 24 0 0 1-24 24h-21a24 24 0 0 1-24-24z",
  "M15.5 49.5a34.5 34.5 0 0 1 69 0V79a8.6 6 0 0 1-17.25 0a8.6 6 0 0 1-17.25 0a8.6 6 0 0 1-17.25 0a8.6 6 0 0 1-17.25 0z",
];
const TOP = [15, 16, 17, 17, 15];
const HALF = [1, 1, 0.82, 1, 1];

const EYES = [
  <g key="0"><circle cx="42" cy="48" r="2.2" fill={INK} /><circle cx="58" cy="48" r="2.2" fill={INK} /></g>,
  <g key="1"><ellipse cx="42" cy="48" rx="1.9" ry="3.2" fill={INK} /><ellipse cx="58" cy="48" rx="1.9" ry="3.2" fill={INK} /></g>,
  <path key="2" d="M39.3 49.5q2.7-4.4 5.4 0M55.3 49.5q2.7-4.4 5.4 0" {...line} strokeWidth={1.6} />,
  <path key="3" d="M39.5 48.5h5M55.5 48.5h5" {...line} strokeWidth={1.6} />,
  <g key="4"><circle cx="42" cy="48" r="2.2" fill={INK} /><path d="M55.3 49.5q2.7-4.4 5.4 0" {...line} strokeWidth={1.6} /></g>,
  <g key="5"><circle cx="42" cy="48" r="3.4" fill={INK} /><circle cx="58" cy="48" r="3.4" fill={INK} /><circle cx="43.1" cy="46.8" r="1.1" fill="#fff" /><circle cx="59.1" cy="46.8" r="1.1" fill="#fff" /></g>,
  <g key="6"><circle cx="50" cy="48" r="5" fill="#fff" stroke={INK} strokeWidth="1.3" /><circle cx="50" cy="48" r="2.4" fill={INK} /></g>,
  <g key="7"><circle cx="42" cy="48" r="3.7" fill={INK} /><circle cx="58" cy="48" r="3.7" fill={INK} /><circle cx="43.2" cy="46.6" r="1.2" fill="#fff" /><circle cx="40.8" cy="49.6" r=".6" fill="#fff" /><circle cx="59.2" cy="46.6" r="1.2" fill="#fff" /><circle cx="56.8" cy="49.6" r=".6" fill="#fff" /></g>,
];

const MOUTHS = [
  <path key="0" d="M45 55.5q5 5.4 10 0" {...line} />,
  <path key="1" d="M43.5 55h13a6.5 6.5 0 0 1-13 0z" fill={INK} />,
  <path key="2" d="M46 57.5h8" {...line} />,
  <ellipse key="3" cx="50" cy="58" rx="2.4" ry="2.9" fill={INK} />,
  <path key="4" d="M45 58q6 1.8 10-3" {...line} />,
  <path key="5" d="M44 55.5q3 4 6 0q3 4 6 0" {...line} />,
  <g key="6"><path d="M48 59.2v2.4a2 2 0 0 0 4 0v-2.4z" fill="#ff6b8a" /><path d="M45 55.5q5 5.4 10 0" {...line} /></g>,
];

const stroke = (w: number) => ({ fill: "none", stroke: W, strokeWidth: w, strokeLinecap: "round" as const });
/** Drawn for a body top at y=15; shifted and narrowed per body. */
const GEAR = (b: string): (React.ReactNode | null)[] => [
  null,
  <g key="1"><path d="M50 15V9" {...stroke(1.6)} /><circle className="agent-pulse" cx="50" cy="8" r="2.5" fill="#ffe14d" /></g>,
  <g key="2"><path d="M50 15.5V11" {...stroke(1.6)} /><path d="M50 11.5c-1-4.5 2-7 6.5-7 0 4.5-2.5 7-6.5 7zM50 11.5c1-4.5-2-7-6.5-7 0 4.5 2.5 7 6.5 7z" fill="#4ade80" /></g>,
  <ellipse key="3" className="agent-bob" cx="50" cy="9.5" rx="12" ry="3.2" fill="none" stroke="#ffd54a" strokeWidth="2.2" />,
  <path key="4" d="M20.5 31L23 10l17 10zM79.5 31L77 10 60 20z" fill={W} stroke="rgba(0,0,0,.1)" strokeWidth=".6" strokeLinejoin="round" />,
  <g key="5"><path d="M14 50a36 36 0 0 1 72 0" {...stroke(2.4)} /><rect x="10" y="45" width="6.5" height="13" rx="3" fill={W} stroke="rgba(0,0,0,.12)" strokeWidth=".6" /><rect x="83.5" y="45" width="6.5" height="13" rx="3" fill={W} stroke="rgba(0,0,0,.12)" strokeWidth=".6" /></g>,
  <g key="6"><path d="M20 33a30 24 0 0 1 60 0z" fill={b} stroke="rgba(0,0,0,.15)" strokeWidth=".6" /><rect x="19" y="31" width="62" height="5" rx="2.5" fill={W} stroke="rgba(0,0,0,.1)" strokeWidth=".6" /><circle cx="50" cy="8" r="3.2" fill={W} /></g>,
  null,
  <path key="8" d="M69 24l-9.5-5.5v11zM69 24l9.5-5.5v11z" fill="#ff5d8f" stroke="rgba(0,0,0,.12)" strokeWidth=".6" strokeLinejoin="round" />,
];

const GLASSES = 7;

/** Ghost-style agent character: unique body, eyes, mouth and accessory per agent. `track` follows the cursor, `state="working"` squints and shows thinking dots. */
export function AgentFace({ seed, color, className, track: follow = false, state }: { seed: string; color: string; className?: string; track?: boolean; state?: "working" }) {
  const f = faceOf(color, seed);
  const id = useId();
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => (follow && ref.current ? track(ref.current) : undefined), [follow]);
  const delay = -((seed.length * 1.7) % 6);
  const gear = GEAR(f.b)[f.gear];
  const dy = TOP[f.body]! - 15;
  const shape = <path d={BODIES[f.body]} fill={`url(#${id})`} />;
  return (
    <svg ref={ref} viewBox="5 5 90 90" className={cn("agent-react size-5 shrink-0", state && "agent-working", className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0.17" y1="0" x2="0.33" y2="1">
          <stop offset="0" stopColor={f.a} />
          <stop offset="1" stopColor={f.b} />
        </linearGradient>
      </defs>
      <ellipse cx="50" cy="91" rx="26" ry="2.8" fill="#7d838c" opacity=".22" />
      <g className="agent-bob">
        <g className="agent-pop">
          <g className="agent-body">
            {shape}
            <g transform="translate(50 49) scale(.88) translate(-50 -50)">
              <path d={BODIES[f.body]} fill={`url(#${id})`} />
              <path d={BODIES[f.body]} fill="#fff" opacity=".16" />
            </g>
          </g>
          <g className="agent-head">
            {gear && <g transform={`translate(50 ${dy}) scale(${HALF[f.body]} 1) translate(-50 0)`}>{gear}</g>}
            <g className="agent-cheeks" style={{ "--blush": f.blush ? 0.5 : 0 } as React.CSSProperties}>
              <ellipse cx="35.5" cy="54" rx="3.2" ry="1.9" fill="#ff5d8f" />
              <ellipse cx="64.5" cy="54" rx="3.2" ry="1.9" fill="#ff5d8f" />
            </g>
            <g className="agent-eyes">
              <g className="agent-squint">
                <g className="agent-blink" style={{ animationDelay: `${delay}s` }}>{EYES[f.eye]}</g>
              </g>
            </g>
            {MOUTHS[f.mouth]}
            {f.gear === GLASSES && (
              <g fill="rgba(255,255,255,.22)" stroke={INK} strokeWidth="1.3">
                <circle cx="42" cy="48" r="5.6" />
                <circle cx="58" cy="48" r="5.6" />
                <path d="M47.6 47.5q2.4-1.4 4.8 0" fill="none" />
              </g>
            )}
          </g>
        </g>
      </g>
      {state && [0, 1, 2].map((i) => <circle key={i} className="agent-dot" cx={76 + i * 6} cy={18 - i * 3.5} r={1.9 + i * 0.4} fill="#7d838c" style={{ animationDelay: `${i * 0.2}s` }} />)}
    </svg>
  );
}
