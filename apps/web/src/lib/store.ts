import { create } from "zustand";
import { persist } from "zustand/middleware";

type UI = {
  orgId: string | null;
  setOrgId: (id: string | null) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  newTicketOpen: boolean;
  setNewTicketOpen: (open: boolean) => void;
};

export const useUI = create<UI>()(
  persist(
    (set) => ({
      orgId: null,
      setOrgId: (orgId) => set({ orgId }),
      collapsed: false,
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      newTicketOpen: false,
      setNewTicketOpen: (newTicketOpen) => set({ newTicketOpen }),
    }),
    { name: "zippy-ui", partialize: (s) => ({ orgId: s.orgId, collapsed: s.collapsed }) },
  ),
);
