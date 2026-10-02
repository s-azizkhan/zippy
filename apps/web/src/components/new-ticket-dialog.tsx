import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { Org, Ticket, TicketStatus } from "@zippy/shared";
import { AssigneePicker, FoldersPicker, LabelsPicker, PriorityPicker, StatusPicker } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { api, keys, queryClient, useWorkspaces } from "@/lib/api";
import { useUI } from "@/lib/store";

type Draft = { title: string; body: string; status: TicketStatus; priority: Ticket["priority"]; assigneeAgentId: string | null; labelIds: string[]; workspaceIds: string[] | null };
const EMPTY: Draft = { title: "", body: "", status: "todo", priority: "none", assigneeAgentId: null, labelIds: [], workspaceIds: null };

export function NewTicketDialog({ org }: { org: Org }) {
  const { newTicketOpen, setNewTicketOpen } = useUI();
  const { data: workspaces = [] } = useWorkspaces(org.id);
  const navigate = useNavigate();
  const [d, setD] = useState<Draft>(EMPTY);
  const [linearRef, setLinearRef] = useState<string | null>(null); // null = write a new issue
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  // Default to the first folder until the user picks.
  const workspaceIds = d.workspaceIds ?? (workspaces[0] ? [workspaces[0].id] : []);
  const ready = linearRef === null ? !!d.title.trim() : !!linearRef.trim();

  async function create() {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const t =
        linearRef === null
          ? await api.post<Ticket>(`/orgs/${org.id}/tickets`, { ...d, workspaceIds })
          : await api.post<Ticket>(`/orgs/${org.id}/linear/import`, { ref: linearRef, workspaceIds, assigneeAgentId: d.assigneeAgentId });
      if (linearRef === null && d.assigneeAgentId) await api.post(`/tickets/${t.id}/run`, {});
      queryClient.invalidateQueries({ queryKey: keys.res(org.id, "tickets") });
      setD({ ...EMPTY, workspaceIds: d.workspaceIds });
      setLinearRef(null);
      if (!more) {
        setNewTicketOpen(false);
        navigate(`/t/${t.id}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={newTicketOpen} onOpenChange={setNewTicketOpen}>
      <DialogContent showCloseButton className="top-[12%] translate-y-0 gap-0 p-0 sm:max-w-[720px]" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), create())}>
        <div className="flex items-center gap-1.5 px-4 pt-3.5 text-xs">
          <span className="bg-accent rounded-md border px-1.5 py-0.5 font-medium">{org.key}</span>
          <ChevronRight className="text-muted-foreground size-3" aria-hidden />
          <DialogTitle className="text-xs font-normal">{linearRef === null ? "New issue" : "Import from Linear"}</DialogTitle>
          <DialogDescription className="sr-only">Describe the work. Assign an agent to start it right away.</DialogDescription>
          {org.linearConnected && (
            <button type="button" className="text-muted-foreground hover:text-foreground ml-3 underline underline-offset-4" onClick={() => setLinearRef(linearRef === null ? "" : null)}>
              {linearRef === null ? "Import from Linear instead" : "Write a new issue instead"}
            </button>
          )}
        </div>

        <div className="grid gap-1 px-4 pt-3 pb-2">
          {linearRef !== null ? (
            <input
              aria-label="Linear issue ID or URL"
              placeholder="COM-123 or https://linear.app/…/issue/COM-123/…"
              value={linearRef}
              onChange={(e) => setLinearRef(e.target.value)}
              className="placeholder:text-muted-foreground h-10 bg-transparent font-mono text-[15px] outline-none"
              autoFocus
            />
          ) : (
            <>
              <input
                aria-label="Issue title"
                placeholder="Issue title"
                value={d.title}
                onChange={(e) => set("title", e.target.value)}
                className="placeholder:text-muted-foreground h-10 bg-transparent text-lg font-medium outline-none"
                autoFocus
              />
              <textarea
                aria-label="Description"
                placeholder="Add description… (markdown)"
                value={d.body}
                onChange={(e) => set("body", e.target.value)}
                className="placeholder:text-muted-foreground min-h-28 resize-none bg-transparent text-[14px] leading-relaxed outline-none"
              />
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          {linearRef === null && (
            <>
              <StatusPicker chip value={d.status} onChange={(v) => set("status", v)} />
              <PriorityPicker chip value={d.priority} onChange={(v) => set("priority", v)} />
            </>
          )}
          <AssigneePicker chip orgId={org.id} value={d.assigneeAgentId} onChange={(v) => set("assigneeAgentId", v)} />
          {linearRef === null && <LabelsPicker chip orgId={org.id} value={d.labelIds} onChange={(v) => set("labelIds", v)} />}
          <FoldersPicker chip orgId={org.id} value={workspaceIds} onChange={(v) => set("workspaceIds", v)} />
        </div>

        <div className="flex items-center justify-end gap-3 border-t px-4 py-2.5">
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <Switch checked={more} onCheckedChange={setMore} /> Create more
          </label>
          <Button size="sm" onClick={create} disabled={!ready || busy}>
            {linearRef !== null ? "Import issue" : d.assigneeAgentId ? "Create & start" : "Create issue"} <Kbd className="ml-1">⌘↵</Kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
