import type { useAnimation } from "motion/react";
import { useEffect, type RefObject } from "react";

const HOST = "a,button,label,[role=menuitem],[role=tab],[role=option],[data-row]";

/** Animate the icon when its whole row (link/button/menu item) is hovered, not just the glyph. */
export function useHostHover(ref: RefObject<HTMLElement | null>, controls: ReturnType<typeof useAnimation>) {
  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>(HOST);
    if (!host) return;
    const on = () => void controls.start("animate");
    const off = () => void controls.start("normal");
    host.addEventListener("mouseenter", on);
    host.addEventListener("mouseleave", off);
    return () => {
      host.removeEventListener("mouseenter", on);
      host.removeEventListener("mouseleave", off);
    };
  }, [ref, controls]);
}

export type IconType = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
