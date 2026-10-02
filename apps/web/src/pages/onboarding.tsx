import { useState } from "react";
import { orgInput, workspaceInput } from "@zippy/shared";
import { Field, fieldErrors } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, createOrg, keys, queryClient } from "@/lib/api";
import { useUI } from "@/lib/store";

export function Onboarding() {
  const [form, setForm] = useState({ name: "", key: "", wsName: "", wsPath: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const setOrgId = useUI((s) => s.setOrgId);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const org = orgInput.safeParse({ name: form.name, key: form.key });
    const ws = workspaceInput.safeParse({ name: form.wsName, path: form.wsPath });
    const errs = {
      ...(org.success ? {} : fieldErrors(org.error.issues)),
      ...(ws.success ? {} : Object.fromEntries(Object.entries(fieldErrors(ws.error.issues)).map(([k, v]) => [`ws${k[0]!.toUpperCase()}${k.slice(1)}`, v]))),
    };
    setErrors(errs);
    if (!org.success || !ws.success) return;
    setBusy(true);
    try {
      const o = await createOrg(org.data);
      await api.post(`/orgs/${o.id}/workspaces`, ws.data);
      setOrgId(o.id);
      await queryClient.invalidateQueries({ queryKey: keys.orgs });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="grid w-full max-w-md gap-6" noValidate>
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Set up Zippy</h1>
          <p className="text-muted-foreground text-sm">Create an organization and add your first working folder. Default agents are added for you.</p>
        </div>
        <fieldset className="grid gap-4">
          <legend className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Organization</legend>
          <Field label="Name" error={errors.name}>
            {(p) => <Input {...p} value={form.name} onChange={set("name")} placeholder="Fanbasis" autoFocus />}
          </Field>
          <Field label="Ticket key" hint="Prefix for ticket IDs, like FB-12." error={errors.key}>
            {(p) => <Input {...p} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} placeholder="FB" maxLength={6} />}
          </Field>
        </fieldset>
        <fieldset className="grid gap-4">
          <legend className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Working folder</legend>
          <Field label="Name" error={errors.wsName}>
            {(p) => <Input {...p} value={form.wsName} onChange={set("wsName")} placeholder="payments" />}
          </Field>
          <Field label="Absolute path" hint="A git repo on this machine. Agents work here." error={errors.wsPath}>
            {(p) => <Input {...p} value={form.wsPath} onChange={set("wsPath")} placeholder="/Users/you/code/repo" className="font-mono text-[13px]" />}
          </Field>
        </fieldset>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create organization"}
        </Button>
      </form>
    </main>
  );
}
