import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { orgInput, profileInput, workspaceInput, type Profile } from "@zippy/shared";
import { AgentFace } from "@/components/agent-face";
import { Field, fieldErrors } from "@/components/field";
import { ProfileFields } from "@/components/profile-fields";
import { FolderGit2Icon } from "@/components/ui/folder-git-2";
import { Button } from "@/components/ui/button";
import { DbForm } from "@/components/db-form";
import { Input } from "@/components/ui/input";
import { api, createOrg, keys, queryClient, useDb } from "@/lib/api";
import { useUI } from "@/lib/store";
import { cn } from "@/lib/utils";

const DB_STEP = { id: "db", label: "Database", title: "Where should data live?", sub: "Zippy keeps everything in Postgres, on this machine by default." } as const;
const STEPS = [
  { id: "org", label: "Organization", title: "Name your team", sub: "The home for your tickets, Zippers and pipelines." },
  { id: "you", label: "You", title: "Who's the human?", sub: "Zippers sign their commits as you and learn how you like to work." },
  { id: "agents", label: "Zippers", title: "Meet your coworkers", sub: "Pick the pre-built Zippers to bring along. Tweak or add more anytime." },
  { id: "folder", label: "Folder", title: "Point them at some code", sub: "A git repo on this machine. Zippers get their own worktree here." },
] as const;

const kicker = "text-muted-foreground text-xs font-medium tracking-wide uppercase";

export function Onboarding({ onCancel }: { onCancel?: () => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ name: "", key: "", wsName: "", wsPath: "" });
  const [profile, setProfile] = useState<Profile>(() => profileInput.parse({}));
  const [picked, setPicked] = useState<string[] | null>(null); // null = all
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dbDirty, setDbDirty] = useState(false);
  const { data: db } = useDb();
  const steps = db?.desktop ? [DB_STEP, ...STEPS] : STEPS;
  const setOrgId = useUI((s) => s.setOrgId);
  const { data: library = [] } = useQuery({ queryKey: ["default-agents"], queryFn: () => api.get<{ handle: string; name: string; color: string; description: string }[]>("/default-agents") });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const handles = library.map((a) => a.handle);
  const chosen = picked ?? handles;
  const toggle = (h: string) => setPicked(handles.filter((x) => (x === h ? !chosen.includes(h) : chosen.includes(x))));

  const org = orgInput.safeParse({ name: form.name, key: form.key, profile });
  const ws = workspaceInput.safeParse({ name: form.wsName, path: form.wsPath });
  const wsErrors = ws.success ? {} : Object.fromEntries(Object.entries(fieldErrors(ws.error.issues)).map(([k, v]) => [`ws${k[0]!.toUpperCase()}${k.slice(1)}`, v]));
  const orgErrors = org.success ? {} : fieldErrors(org.error.issues);
  const s = steps[step]!;
  const stepOk = { db: !dbDirty, org: !orgErrors.name && !orgErrors.key, you: !orgErrors.profile, agents: true, folder: ws.success };
  const stepErrors = { db: {}, org: orgErrors, you: {}, agents: {}, folder: wsErrors }[s.id];

  async function browse() {
    const { path } = await api.post<{ path: string | null }>("/system/pick-folder");
    if (path) setForm((f) => ({ ...f, wsPath: path, wsName: f.wsName || path.split("/").pop()! }));
  }

  async function next(e: React.FormEvent) {
    e.preventDefault();
    if (!stepOk[s.id]) return setErrors(stepErrors);
    setErrors({});
    if (step < steps.length - 1) return setStep(step + 1);
    if (!org.success || !ws.success) return;
    setBusy(true);
    try {
      const o = await createOrg({ ...org.data, agents: picked ?? undefined } as typeof org.data);
      await api.post(`/orgs/${o.id}/workspaces`, ws.data);
      setOrgId(o.id);
      onCancel?.();
      await queryClient.invalidateQueries({ queryKey: keys.orgs });
    } finally {
      setBusy(false);
    }
  }

  const last = step === steps.length - 1;
  return (
    <main className="bg-background grid min-h-dvh lg:grid-cols-[26rem_1fr]">
      <aside className="bg-sidebar relative hidden flex-col justify-between overflow-hidden border-r p-10 lg:flex">
        <div className="bg-primary/20 pointer-events-none absolute -top-24 -left-24 size-96 rounded-full blur-3xl" aria-hidden />
        <div className="bg-primary/10 pointer-events-none absolute -right-32 bottom-0 size-96 rounded-full blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-bold tracking-tight">Zippy</span>
        </div>
        <div className="relative grid gap-8">
          <h1 className="text-4xl leading-[1.1] font-bold tracking-tight text-balance">
            Zipper coworkers
            <br />
            <span className="text-primary">for your tickets.</span>
          </h1>
          <ol className="grid gap-1" aria-label="Setup progress">
            {steps.map((t, i) => (
              <li key={t.id} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors", i === step ? "bg-background/70 font-medium shadow-sm" : "text-muted-foreground")}>
                <span className={cn("flex size-6 items-center justify-center rounded-full border text-xs tabular-nums transition-colors", i < step && "bg-primary border-primary text-white", i === step && "border-primary text-primary")}>{i < step ? "✓" : i + 1}</span>
                {t.label}
              </li>
            ))}
          </ol>
        </div>
        <p className="text-muted-foreground relative text-xs">Everything stays on this machine.</p>
      </aside>

      <form onSubmit={next} noValidate className="flex min-h-dvh flex-col px-6 py-8 sm:px-12">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between">
          <p className={kicker}>
            Step {step + 1} of {steps.length}
          </p>
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        <div className="bg-border mx-auto mt-3 h-0.5 w-full max-w-xl overflow-hidden rounded-full" aria-hidden>
          <motion.div className="bg-primary h-full" animate={{ width: `${((step + 1) / steps.length) * 100}%` }} transition={{ type: "spring", stiffness: 200, damping: 30 }} />
        </div>

        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center py-10">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={s.id} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.2 }} className="grid gap-8">
              <div className="grid gap-2">
                <h2 className="text-3xl font-bold tracking-tight">{s.title}</h2>
                <p className="text-muted-foreground">{s.sub}</p>
              </div>

              {s.id === "db" && <DbForm onDirty={setDbDirty} />}

              {s.id === "org" && (
                <div className="grid gap-5">
                  <Field label="Organization name" error={errors.name}>
                    {(p) => <Input {...p} value={form.name} onChange={set("name")} placeholder="Fanbasis" autoFocus className="h-11 text-base" />}
                  </Field>
                  <Field label="Ticket key" hint="Prefix for ticket IDs." error={errors.key}>
                    {(p) => <Input {...p} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} placeholder="FB" maxLength={6} className="h-11 font-mono text-base" />}
                  </Field>
                  <div className="flex items-center gap-3 rounded-xl border border-dashed p-3 text-sm">
                    <span className="bg-primary flex size-9 items-center justify-center rounded-lg font-bold text-white">{form.name.trim().slice(0, 1).toUpperCase() || "?"}</span>
                    <span className="grid">
                      <span className="font-semibold">{form.name.trim() || "Your organization"}</span>
                      <span className="text-muted-foreground font-mono text-xs">{form.key || "KEY"}-12 · first ticket</span>
                    </span>
                  </div>
                </div>
              )}

              {s.id === "you" && (
                <div className="grid gap-5">
                  <ProfileFields profile={profile} onChange={setProfile} />
                  {(profile.name || profile.githubUsername) && (
                    <p className="text-muted-foreground rounded-xl border border-dashed p-3 font-mono text-xs">
                      commits as {profile.name || profile.githubUsername} &lt;{profile.githubEmail || "git config"}&gt;
                    </p>
                  )}
                </div>
              )}

              {s.id === "agents" && (
                <div className="grid gap-3">
                  <div className="flex items-center justify-between">
                    <span className={kicker}>
                      {chosen.length} of {handles.length} selected
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(chosen.length === handles.length ? [] : null)}>
                      {chosen.length === handles.length ? "Clear all" : "Select all"}
                    </Button>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {library.map((a, i) => {
                      const on = chosen.includes(a.handle);
                      return (
                        <motion.label
                          key={a.handle}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.04 }}
                          className={cn("focus-within:ring-ring/60 relative flex cursor-pointer gap-3 rounded-xl border p-3 transition-all focus-within:ring-2 hover:-translate-y-0.5 hover:shadow-md", on ? "border-primary bg-primary/5" : "opacity-60 hover:opacity-100")}
                        >
                          <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(a.handle)} />
                          <AgentFace seed={a.handle} color={a.color} className="size-11 shrink-0" />
                          <span className="grid min-w-0 content-start">
                            <span className="truncate text-[13px] font-semibold">{a.name}</span>
                            <span className="text-muted-foreground font-mono text-[11px]">@{a.handle}</span>
                            <span className="text-muted-foreground mt-1 line-clamp-2 text-xs">{a.description}</span>
                          </span>
                          {on && <span className="bg-primary absolute top-2 right-2 flex size-4 items-center justify-center rounded-full text-[10px] text-white" aria-hidden>✓</span>}
                        </motion.label>
                      );
                    })}
                  </div>
                </div>
              )}

              {s.id === "folder" && (
                <div className="grid gap-5">
                  <Field label="Folder name" error={errors.wsName}>
                    {(p) => <Input {...p} value={form.wsName} onChange={set("wsName")} placeholder="payments" autoFocus className="h-11 text-base" />}
                  </Field>
                  <Field label="Absolute path" hint="You can add more folders later." error={errors.wsPath}>
                    {(p) => (
                      <div className="flex gap-2">
                        <Input {...p} value={form.wsPath} onChange={set("wsPath")} placeholder="/Users/you/code/repo" className="h-11 font-mono text-sm" />
                        <Button type="button" variant="outline" className="h-11" onClick={browse}>
                          <FolderGit2Icon aria-hidden /> Browse
                        </Button>
                      </div>
                    )}
                  </Field>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mx-auto flex w-full max-w-xl items-center justify-between">
          <Button type="button" variant="ghost" onClick={() => setStep(step - 1)} className={cn(!step && "invisible")}>
            Back
          </Button>
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Creating…" : last ? "Launch Zippy →" : "Continue →"}
          </Button>
        </div>
      </form>
    </main>
  );
}
