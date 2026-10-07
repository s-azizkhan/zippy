import { Square } from "lucide-react";
import { Link } from "react-router";
import { AgentAvatar } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api, keys, useAgents, useApiMutation, useRunning } from "@/lib/api";
import { useOrg } from "@/lib/org";

export function RunningPage() {
  const org = useOrg();
  const { data: running = [], isLoading } = useRunning(org.id);
  const { data: agents = [] } = useAgents(org.id);
  const stop = useApiMutation((r: { ticketId: string; agentId: string }) => api.post(`/tickets/${r.ticketId}/cancel`, { agentId: r.agentId }), [keys.res(org.id, "running")]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-[-0.01em]">Running Zippers</h1>
      <p className="text-muted-foreground mt-1 text-[13px]">Every Zipper working right now, on tickets and chats.</p>
      <ul className="mt-6 grid gap-2" aria-live="polite">
        {running.map((r) => {
          const chat = r.ticket.kind === "chat";
          return (
            <li key={`${r.ticket.id}:${r.agentId}`} className="bg-card flex items-center gap-3 rounded-xl border px-3 py-2.5">
              <AgentAvatar agent={agents.find((a) => a.id === r.agentId)} running />
              <Link to={chat ? `/chat/${r.ticket.id}` : `/t/${r.ticket.identifier}`} className="min-w-0 flex-1 text-[13px]">
                <span className="font-medium">{agents.find((a) => a.id === r.agentId)?.name}</span>
                <span className="text-muted-foreground"> on </span>
                {!chat && <span className="text-muted-foreground font-mono text-xs">{r.ticket.identifier} </span>}
                <span className="truncate">{chat ? `chat: ${r.ticket.title}` : r.ticket.title}</span>
              </Link>
              <span className="text-muted-foreground text-xs tabular-nums">${r.costUsd.toFixed(2)}</span>
              <Button size="xs" variant="outline" onClick={() => stop.mutate({ ticketId: r.ticket.id, agentId: r.agentId })}>
                <Square className="size-2.5 fill-current" aria-hidden /> Stop
              </Button>
            </li>
          );
        })}
      </ul>
      {!isLoading && !running.length && <p className="text-muted-foreground mt-6 rounded-xl border border-dashed px-4 py-8 text-center text-[13px]">No Zippers running right now.</p>}
      </div>
    </div>
  );
}
