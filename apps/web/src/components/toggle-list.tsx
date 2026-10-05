import { DownloadIcon as Download } from "@/components/ui/download";
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
  const [first] = useState(toggles); // order frozen at mount: live edits don't reshuffle
  const top = <T extends Pick<CatalogItem, "id" | "defaultOn">>(items: T[]) => items.toSorted((a, b) => +(first[b.id] ?? base[b.id] ?? b.defaultOn) - +(first[a.id] ?? base[a.id] ?? a.defaultOn));
  const put = (t: Record<string, boolean>, i: Pick<CatalogItem, "id" | "defaultOn">, v: boolean) => {
    const { [i.id]: _, ...rest } = t;
    return v === (base[i.id] ?? i.defaultOn) && Object.keys(base).length ? rest : { ...rest, [i.id]: v };
  };
  const set = (i: Pick<CatalogItem, "id" | "defaultOn">, v: boolean) => onChange(put(toggles, i, v));
  const [sel, setSel] = useState<Record<string, Pick<CatalogItem, "id" | "defaultOn">>>({});
  const pick = (i: Pick<CatalogItem, "id" | "defaultOn">) => setSel(({ [i.id]: was, ...rest }) => (was ? rest : { ...rest, [i.id]: i }));
  const bulk = (v: boolean) => {
    onChange(Object.values(sel).reduce((t, i) => put(t, i, v), toggles));
    setSel({});
  };
  const all = (items: Pick<CatalogItem, "id" | "defaultOn">[]) => {
    const full = items.every((i) => sel[i.id]);
    setSel((s) => Object.fromEntries(Object.entries(s).filter(([id]) => !items.some((i) => i.id === id)).concat(full ? [] : items.map((i) => [i.id, i]))));
  };
  const check = (i: Pick<CatalogItem, "id" | "defaultOn">, name: string) => (
    <input type="checkbox" className="accent-primary size-4 shrink-0" aria-label={`Select ${name}`} checked={!!sel[i.id]} onClick={(e) => e.stopPropagation()} onChange={() => pick(i)} />
  );
  const head = (title: string, items: Pick<CatalogItem, "id" | "defaultOn">[]) => (
    <div className="flex items-center justify-between">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {!!items.length && (
        <button type="button" className="text-muted-foreground hover:text-foreground text-xs" onClick={() => all(items)}>
          {items.every((i) => sel[i.id]) ? "Deselect all" : "Select all"}
        </button>
      )}
    </div>
  );
  const group = (kind: CatalogItem["kind"], title: string) => {
    const items = top(data?.items.filter((i) => i.kind === kind && match(i)) ?? []);
    return (
    <section className="grid gap-1">
      {head(title, items)}
      <ul className="divide-y rounded-lg border">
        {items.map((i) => (
          <li key={i.id} className="flex cursor-pointer items-center gap-3 px-3 py-2" onClick={() => set(i, !on(i))}>
            {check(i, i.name)}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium break-words">
                {i.name} <Badge variant="outline">{i.source}</Badge>
              </p>
              {i.description && <p className="text-muted-foreground text-xs break-words">{i.description}</p>}
            </div>
            <Switch aria-label={i.name} checked={on(i)} onClick={(e) => e.stopPropagation()} onCheckedChange={(v) => set(i, v)} />
          </li>
        ))}
      </ul>
    </section>
    );
  };
  const rules = top(RULES.map((r) => ({ ...r, id: `rule:${r.id}` })).filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(q.trim().toLowerCase())));
  const n = Object.keys(sel).length;

  return (
    <div className="grid gap-5">
      <Input type="search" aria-label="Search skills and MCP servers" placeholder="Search rules, skills & MCP…" value={q} onChange={(e) => setQ(e.target.value)} />
      {n > 0 && (
        <div className="bg-muted flex items-center gap-2 rounded-lg border px-3 py-2">
          <span className="flex-1 text-[13px] font-medium">{n} selected</span>
          <Button type="button" size="sm" onClick={() => bulk(true)}>Enable</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => bulk(false)}>Disable</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSel({})}>Clear</Button>
        </div>
      )}
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
        {head("Rules", rules)}
        <ul className="divide-y rounded-lg border">
          {rules.map((r) => (
            <li key={r.id} className="flex cursor-pointer items-center gap-3 px-3 py-2" onClick={() => set(r, !on(r))}>
              {check(r, r.name)}
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{r.name}</p>
                <p className="text-muted-foreground text-xs">{r.description}</p>
              </div>
              <Switch aria-label={r.name} checked={on(r)} onClick={(e) => e.stopPropagation()} onCheckedChange={(v) => set(r, v)} />
            </li>
          ))}
        </ul>
      </section>
      {group("skill", "Skills")}
      {group("mcp", "MCP servers (Claude Code & Desktop)")}
    </div>
  );
}
