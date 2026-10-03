import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TicketDraft = { title: string; body: string; workspaceIds: string[]; commentId: string };

type UI = {
  orgId: string | null;
  setOrgId: (id: string | null) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  split: boolean;
  toggleSplit: () => void;
  hideProps: boolean;
  toggleProps: () => void;
  favorites: string[];
  toggleFavorite: (id: string) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
  newTicketOpen: boolean;
  setNewTicketOpen: (open: boolean) => void;
  ticketDraft: TicketDraft | null; // prefill for the new-issue dialog (from a chat)
  openTicketDraft: (d: TicketDraft) => void;
};

export const useUI = create<UI>()(
  persist(
    (set) => ({
      orgId: null,
      setOrgId: (orgId) => set({ orgId }),
      collapsed: false,
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      split: false,
      toggleSplit: () => set((s) => ({ split: !s.split })),
      hideProps: false,
      toggleProps: () => set((s) => ({ hideProps: !s.hideProps })),
      favorites: [],
      toggleFavorite: (id) => set((s) => ({ favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id] })),
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      onboardingOpen: false,
      setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
      newTicketOpen: false,
      setNewTicketOpen: (newTicketOpen) => set({ newTicketOpen, ticketDraft: null }),
      ticketDraft: null,
      openTicketDraft: (ticketDraft) => set({ newTicketOpen: true, ticketDraft }),
    }),
    { name: "zippy-ui", partialize: (s) => ({ orgId: s.orgId, collapsed: s.collapsed, split: s.split, hideProps: s.hideProps, favorites: s.favorites }) },
  ),
);
