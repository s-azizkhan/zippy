import { Bot, ListTodo, Plus, Settings, Workflow } from "lucide-react";
import { useNavigate } from "react-router";
import type { Org } from "@zippy/shared";
import { StatusIcon } from "@/components/status";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useTickets } from "@/lib/api";
import { SETTINGS_TABS } from "@/lib/settings-tabs";
import { useUI } from "@/lib/store";

export function CommandPalette({ org }: { org: Org }) {
  const { paletteOpen, setPaletteOpen, setNewTicketOpen } = useUI();
  const { data: tickets = [] } = useTickets(org.id);
  const navigate = useNavigate();
  const run = (fn: () => void) => () => (setPaletteOpen(false), fn());

  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen} title="Command menu" description="Search tickets or run a command">
      <CommandInput placeholder="Type a command or search tickets…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={run(() => setNewTicketOpen(true))}>
            <Plus aria-hidden /> New ticket
          </CommandItem>
          <CommandItem onSelect={run(() => navigate("/"))}>
            <ListTodo aria-hidden /> Go to tickets
          </CommandItem>
          <CommandItem onSelect={run(() => navigate("/agents"))}>
            <Bot aria-hidden /> Go to agents
          </CommandItem>
          <CommandItem onSelect={run(() => navigate("/pipelines"))}>
            <Workflow aria-hidden /> Go to pipelines
          </CommandItem>
          <CommandItem onSelect={run(() => navigate("/settings"))}>
            <Settings aria-hidden /> Go to settings
          </CommandItem>
          {SETTINGS_TABS.map((t) => (
            <CommandItem key={t.value} value={`settings ${t.label}`} onSelect={run(() => navigate(`/settings?tab=${t.value}`))}>
              <Settings aria-hidden /> Settings → {t.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Tickets">
          {tickets.map((t) => (
            <CommandItem key={t.id} value={`${t.identifier} ${t.title}`} onSelect={run(() => navigate(`/t/${t.id}`))}>
              <StatusIcon status={t.status} />
              <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">{t.identifier}</span>
              <span className="truncate">{t.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
