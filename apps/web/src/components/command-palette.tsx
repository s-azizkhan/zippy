import { ListTodo, Play, SquareTerminal, SunMoon } from "lucide-react";
import { BotIcon as Bot } from "@/components/ui/bot";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { SettingsIcon as Settings } from "@/components/ui/settings";
import { WorkflowIcon as Workflow } from "@/components/ui/workflow";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Org } from "@zippy/shared";
import { StatusIcon } from "@/components/status";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useThemeSwitch } from "@/components/theme-toggle";
import { api, keys, useTerminalTemplates, useTerminals, useTickets, useWorkspaces, type TermInfo } from "@/lib/api";
import { SETTINGS_TABS } from "@/lib/settings-tabs";
import { useUI } from "@/lib/store";

export function CommandPalette({ org }: { org: Org }) {
  const { paletteOpen, setPaletteOpen, setNewTicketOpen } = useUI();
  const { data: tickets = [] } = useTickets(org.id);
  const navigate = useNavigate();
  const { toggle } = useThemeSwitch();
  const { data: terms = [] } = useTerminals(org.id);
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const { data: templates = [] } = useTerminalTemplates(org.id);
  const qc = useQueryClient();
  const termKey = keys.res(org.id, "terminals");
  const newTerm = (workspaceId: string) =>
    api.post<TermInfo>(`/workspaces/${workspaceId}/terminals`, {}, true).then((t) => (qc.setQueryData<TermInfo[]>(termKey, (ts = []) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t])), navigate(`/terminals/${t.id}`)));
  // Focuses the first new shell; the rest show up in the Terminals sidebar.
  const runTpl = (id: string) => api.post<TermInfo[]>(`/terminal-templates/${id}/run`, {}, true).then((ts) => (qc.invalidateQueries({ queryKey: termKey }), ts[0] && navigate(`/terminals/${ts[0].id}`)));
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
          <CommandItem onSelect={run(() => navigate("/zippers"))}>
            <Bot aria-hidden /> Go to agents
          </CommandItem>
          <CommandItem onSelect={run(() => navigate("/pipelines"))}>
            <Workflow aria-hidden /> Go to pipelines
          </CommandItem>
          <CommandItem onSelect={run(() => navigate("/settings"))}>
            <Settings aria-hidden /> Go to settings
          </CommandItem>
          <CommandItem value="toggle theme dark light" onSelect={run(() => toggle())}>
            <SunMoon aria-hidden /> Toggle theme
          </CommandItem>
          {SETTINGS_TABS.map((t) => (
            <CommandItem key={t.value} value={`settings ${t.label}`} onSelect={run(() => navigate(`/settings?tab=${t.value}`))}>
              <Settings aria-hidden /> Settings → {t.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Terminals">
          {terms.map((t) => (
            <CommandItem key={t.id} value={`terminal ${t.title} ${t.process} ${workspaces.find((w) => w.id === t.workspaceId)?.name ?? ""}`} onSelect={run(() => navigate(`/terminals/${t.id}`))}>
              <SquareTerminal aria-hidden /> <span className="truncate font-mono text-xs">{t.title}</span>
              <span className="text-muted-foreground truncate text-xs">{workspaces.find((w) => w.id === t.workspaceId)?.name}</span>
            </CommandItem>
          ))}
          {templates.map((t) => (
            <CommandItem key={t.id} value={`run template ${t.name}`} onSelect={run(() => void runTpl(t.id))}>
              <Play aria-hidden /> Run template: {t.name}
            </CommandItem>
          ))}
          {workspaces.map((w) => (
            <CommandItem key={w.id} value={`new terminal shell ${w.name}`} onSelect={run(() => void newTerm(w.id))}>
              <Plus aria-hidden /> New terminal in {w.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Tickets">
          {tickets.map((t) => (
            <CommandItem key={t.id} value={`${t.identifier} ${t.title}`} onSelect={run(() => navigate(`/t/${t.identifier}`))}>
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
