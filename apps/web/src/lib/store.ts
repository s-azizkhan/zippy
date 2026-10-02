import { create } from "zustand";
import { persist } from "zustand/middleware";

type UI = {
  orgId: string | null;
  setOrgId: (id: string | null) => void;
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
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      newTicketOpen: false,
      setNewTicketOpen: (newTicketOpen) => set({ newTicketOpen }),
    }),
    { name: "zippy-ui", partialize: (s) => ({ orgId: s.orgId }) },
  ),
);
