import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, queryClient, useDb } from "@/lib/api";
import { cn } from "@/lib/utils";

type Test = { ok: true } | { ok: false; missing: boolean; error: string };

const MODES = [
  { id: "embedded", label: "Built-in", hint: "Local Postgres managed by Zippy. Nothing to set up." },
  { id: "custom", label: "My own Postgres", hint: "Point at an existing server, or create the database on it." },
] as const;

/** Pick the built-in DB or a Postgres URL; test, create if missing, then restart the server on it. */
export function DbForm({ onDirty }: { onDirty?: (dirty: boolean) => void }) {
  const { data: db } = useDb();
  const [picked, setMode] = useState<"embedded" | "custom" | null>(null);
  const [url, setUrl] = useState("");
  const [test, setTest] = useState<Test | null>(null);
  const [busy, setBusy] = useState<"test" | "create" | "save" | null>(null);
  const current = db?.mode === "custom" ? "custom" : "embedded";
  const mode = picked ?? current;
  const dirty = !!db?.desktop && (mode !== current || (mode === "custom" && !!url));
  useEffect(() => onDirty?.(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!db) return null;
  if (!db.desktop)
    return (
      <p className="text-muted-foreground text-[13px]">
        Using <code className="bg-muted rounded px-1">{db.url || "DATABASE_URL"}</code> from <code className="bg-muted rounded px-1">.env</code>. The desktop app lets you change this here.
      </p>
    );

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  const check = () => run("test", async () => setTest(await api.post<Test>("/system/db/test", { url }, true)));
  const create = () => run("create", async () => {
    await api.post("/system/db/create", { url }, true);
    toast.success("Database created");
    setTest(await api.post<Test>("/system/db/test", { url }, true));
  });
  const save = () => run("save", async () => {
    await api.post("/system/db/save", { url: mode === "custom" ? url : null }, true);
    // Server restarts on the new DB; wait until it answers again.
    await new Promise((r) => setTimeout(r, 1000));
    for (let i = 0; i < 120; i++) {
      if (await api.get("/system/db").then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    setUrl("");
    setTest(null);
    await queryClient.invalidateQueries();
    toast.success("Database switched");
  });
  const canSave = mode === "embedded" ? dirty : test?.ok === true;

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Database">
        {MODES.map((m) => (
          <label key={m.id} className={cn("focus-within:ring-ring/60 flex cursor-pointer flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors focus-within:ring-2", mode === m.id ? "border-primary bg-primary/5" : "hover:bg-accent/40")}>
            <input type="radio" name="db-mode" className="sr-only" checked={mode === m.id} onChange={() => (setMode(m.id), setTest(null))} />
            <span className="text-[13px] font-semibold">{m.label}</span>
            <span className="text-muted-foreground text-xs">{m.hint}</span>
          </label>
        ))}
      </div>
      {mode === "custom" && (
        <Field label="Database URL" hint={db.mode === "custom" ? `Current: ${db.url}` : "postgres://user:password@host:5432/zippy"} error={test && !test.ok && !test.missing ? test.error : undefined}>
          {(p) => <Input {...p} value={url} onChange={(e) => (setUrl(e.target.value), setTest(null))} placeholder="postgres://postgres@127.0.0.1:5432/zippy" className="font-mono text-sm" spellCheck={false} />}
        </Field>
      )}
      {mode === "custom" && test && (
        <p className={cn("text-xs", test.ok ? "text-emerald-600" : "text-muted-foreground")} role="status">
          {test.ok ? "Connected." : test.missing ? "Server reachable, but this database doesn't exist yet." : null}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {mode === "custom" && (
          <Button type="button" variant="outline" size="sm" disabled={!url || !!busy} onClick={check}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </Button>
        )}
        {mode === "custom" && test && !test.ok && test.missing && (
          <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={create}>
            {busy === "create" ? "Creating…" : "Create database"}
          </Button>
        )}
        <Button type="button" size="sm" disabled={!canSave || !!busy} onClick={save}>
          {busy === "save" ? "Restarting…" : "Use this database"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">Tables are created automatically. Switching restarts the Zippy server; data in the old database stays where it is.</p>
    </div>
  );
}
