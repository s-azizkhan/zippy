import { Download } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RULES, type Catalog, type CatalogItem } from "@zippy/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, useApiMutation } from "@/lib/api";

const useCatalog = () => useQuery({ queryKey: ["catalog"], queryFn: () => api.get<Catalog>("/catalog"), staleTime: 0 });

/** Skill/MCP switches. `base` = values inherited from the layer above (org); `toggles` = this layer's overrides. */
export function ToggleList({ toggles, base = {}, onChange }: { toggles: Record<string, boolean>; base?: Record<string, boolean>; onChange: (t: Record<string, boolean>) => void }) {
  const { data } = useCatalog();
  const [q, setQ] = useState("");
  const match = (i: CatalogItem) => `${i.name} ${i.description} ${i.source}`.toLowerCase().includes(q.trim().toLowerCase());
  const install = useApiMutation((id: string) => api.post(`/catalog/install/${id}`), [["catalog"]]);
  const on = (i: Pick<CatalogItem, "id" | "defaultOn">) => toggles[i.id] ?? base[i.id] ?? i.defaultOn;
  const set = (i: Pick<CatalogItem, "id" | "defaultOn">, v: boolean) => {
    const { [i.id]: _, ...rest } = toggles;
    onChange(v === (base[i.id] ?? i.defaultOn) && Object.keys(base).length ? rest : { ...rest, [i.id]: v });
  };
  const group = (kind: CatalogItem["kind"], title: string) => (
    <section className="grid gap-1">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <ul className="divide-y rounded-lg border">
        {data?.items.filter((i) => i.kind === kind && match(i)).map((i) => (
          <li key={i.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium break-words">
                {i.name} <Badge variant="outline">{i.source}</Badge>
              </p>
              {i.description && <p className="text-muted-foreground text-xs break-words">{i.description}</p>}
            </div>
            <Switch aria-label={i.name} checked={on(i)} onCheckedChange={(v) => set(i, v)} />
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="grid gap-5">
      <Input type="search" aria-label="Search skills and MCP servers" placeholder="Search rules, skills & MCP…" value={q} onChange={(e) => setQ(e.target.value)} />
      {!!data?.presets.some((p) => !p.installed) && (
        <section className="grid gap-1">
          <h3 className="text-[13px] font-semibold">Install</h3>
          <ul className="divide-y rounded-lg border">
            {data.presets.filter((p) => !p.installed).map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1">
                  <p className="text-[13px] font-medium">{p.name}</p>
                  <p className="text-muted-foreground text-xs">{p.description}</p>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={install.isPending} onClick={() => install.mutate(p.id)}>
                  <Download aria-hidden /> {install.isPending && install.variables === p.id ? "Installing…" : "Install"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="grid gap-1">
        <h3 className="text-[13px] font-semibold">Rules</h3>
        <ul className="divide-y rounded-lg border">
          {RULES.map((r) => ({ ...r, id: `rule:${r.id}` })).filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(q.trim().toLowerCase())).map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{r.name}</p>
                <p className="text-muted-foreground text-xs">{r.description}</p>
              </div>
              <Switch aria-label={r.name} checked={on(r)} onCheckedChange={(v) => set(r, v)} />
            </li>
          ))}
        </ul>
      </section>
      {group("skill", "Skills")}
      {group("mcp", "MCP servers (Claude Code & Desktop)")}
    </div>
  );
}
