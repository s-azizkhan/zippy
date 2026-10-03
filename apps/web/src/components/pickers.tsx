import { Tag } from "lucide-react";
import { FolderGit2Icon as FolderGit2 } from "@/components/ui/folder-git-2";
import { HUMAN, PRIORITIES, TICKET_STATUSES, type Label, type Ticket, type TicketStatus } from "@zippy/shared";
import { PropertyMenu } from "@/components/property-menu";
import { AgentAvatar, LabelDot, UserAvatar, PRIORITY_LABEL, PriorityIcon, STATUS, StatusIcon } from "@/components/status";
import { api, keys, queryClient, useAgents, useLabels, useOrgs, useWorkspaces } from "@/lib/api";
import { cn } from "@/lib/utils";

type Priority = Ticket["priority"];
type Ctl = { open?: boolean; onOpenChange?: (o: boolean) => void; chip?: boolean };

const chipCls = "h-7 rounded-md border px-2 text-xs";
const muted = "text-muted-foreground";

export function StatusPicker({ value, onChange, ...ctl }: { value: TicketStatus; onChange: (v: TicketStatus) => void } & Ctl) {
  return (
    <PropertyMenu
      {...ctl}
      className={cn(ctl.chip && chipCls)}
      triggerLabel={`Status: ${STATUS[value].label}`}
      placeholder="Change status…"
      value={value}
      onChange={(v) => onChange(v as TicketStatus)}
      options={TICKET_STATUSES.map((s) => ({ value: s, label: STATUS[s].label, icon: <StatusIcon status={s} /> }))}
      trigger={
        <>
          <StatusIcon status={value} /> <span className="truncate">{STATUS[value].label}</span>
        </>
      }
    />
  );
}

export function PriorityPicker({ value, onChange, ...ctl }: { value: Priority; onChange: (v: Priority) => void } & Ctl) {
  return (
    <PropertyMenu
      {...ctl}
      className={cn(ctl.chip && chipCls)}
      triggerLabel={`Priority: ${PRIORITY_LABEL[value]}`}
      placeholder="Change priority…"
      value={value}
      onChange={(v) => onChange(v as Priority)}
      options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))}
      trigger={
        <>
          <PriorityIcon priority={value} />
          <span className={cn("truncate", value === "none" && muted)}>{value === "none" && ctl.chip ? "Priority" : PRIORITY_LABEL[value]}</span>
        </>
      }
    />
  );
}

const NONE = "none";

export function AssigneePicker({ orgId, value, onChange, ...ctl }: { orgId: string; value: string | null; onChange: (v: string | null) => void } & Ctl) {
  const { data: agents = [] } = useAgents(orgId);
  const { data: orgs = [] } = useOrgs();
  const { name = "", handle = "" } = orgs.find((o) => o.id === orgId)?.profile ?? {};
  const human = handle ? { name: name || `@${handle}` } : null; // only a handled human can be tagged
  const a = value === HUMAN ? human : agents.find((x) => x.id === value);
  const avatar = (x: typeof a, cls: string) => (x && x === human ? <UserAvatar name={x.name} className={cls} /> : <AgentAvatar agent={x as (typeof agents)[number] | undefined} className={cls} />);
  return (
    <PropertyMenu
      {...ctl}
      className={cn(ctl.chip && chipCls)}
      triggerLabel={`Assignee: ${a?.name ?? "No assignee"}`}
      placeholder="Assign to Zipper…"
      value={value ?? NONE}
      onChange={(v) => onChange(v === NONE ? null : v)}
      options={[
        { value: NONE, label: "No assignee", icon: <AgentAvatar agent={null} className="size-4" /> },
        ...(human ? [{ value: HUMAN, label: human.name, icon: avatar(human, "size-4 text-[9px]"), group: "People" }] : []),
        ...agents.map((x) => ({ value: x.id, label: x.name, icon: <AgentAvatar agent={x} className="size-4 text-[9px]" />, group: "Zippers" })),
      ]}
      trigger={
        <>
          {avatar(a, "size-4 text-[9px]")}
          <span className={cn("truncate", !a && muted)}>{a?.name ?? (ctl.chip ? "Assignee" : "No assignee")}</span>
        </>
      }
    />
  );
}

export function LabelsPicker({ orgId, value, onChange, ...ctl }: { orgId: string; value: string[]; onChange: (v: string[]) => void } & Ctl) {
  const { data: labels = [] } = useLabels(orgId);
  async function create(name: string) {
    const colors = ["#5e6ad2", "#26b5ce", "#4cb782", "#f2c94c", "#f2994a", "#eb5757", "#bb87fc"];
    const l = await api.post<Label>(`/orgs/${orgId}/labels`, { name, color: colors[labels.length % colors.length] });
    await queryClient.invalidateQueries({ queryKey: keys.res(orgId, "labels") });
    onChange([...value, l.id]);
  }
  return (
    <PropertyMenu
      {...ctl}
      multi
      className={cn(ctl.chip ? chipCls : "w-auto")}
      triggerLabel="Labels"
      placeholder="Add labels…"
      value={value}
      onChange={onChange}
      onCreate={create}
      options={labels.map((l) => ({ value: l.id, label: l.name, icon: <LabelDot color={l.color} /> }))}
      trigger={ctl.chip ? <><Tag className="size-3.5" aria-hidden /> {value.length ? `${value.length} labels` : <span className={muted}>Labels</span>}</> : <span className="text-base leading-none" aria-hidden>+</span>}
    />
  );
}

export function FoldersPicker({ orgId, value, onChange, ...ctl }: { orgId: string; value: string[]; onChange: (v: string[]) => void } & Ctl) {
  const { data: workspaces = [] } = useWorkspaces(orgId);
  const names = value.map((id) => workspaces.find((w) => w.id === id)?.name).filter(Boolean);
  return (
    <PropertyMenu
      {...ctl}
      multi
      className={cn(ctl.chip && chipCls)}
      triggerLabel={`Folders: ${names.join(", ") || "none"}`}
      placeholder="Working folders…"
      value={value}
      onChange={onChange}
      options={workspaces.map((w) => ({ value: w.id, label: w.name, icon: <FolderGit2 className="text-muted-foreground size-3.5" aria-hidden /> }))}
      trigger={
        <>
          <FolderGit2 className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className={cn("truncate", !names.length && muted)}>{names.join(", ") || "Folders"}</span>
        </>
      }
    />
  );
}

/** Label chips like Linear's: dot + name in a pill. */
export function LabelChips({ orgId, ids, className }: { orgId: string; ids: string[]; className?: string }) {
  const { data: labels = [] } = useLabels(orgId);
  const chosen = labels.filter((l) => ids.includes(l.id));
  if (!chosen.length) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {chosen.map((l) => (
        <span key={l.id} className="inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs">
          <LabelDot color={l.color} /> {l.name}
        </span>
      ))}
    </span>
  );
}
