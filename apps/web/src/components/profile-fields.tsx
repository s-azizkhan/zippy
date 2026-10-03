import { profileInput, type Profile } from "@zippy/shared";
import { Field, fieldErrors } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Who the human is. Git identity is used for agent commits. */
export function ProfileFields({ profile, onChange }: { profile: Profile; onChange: (p: Profile) => void }) {
  const r = profileInput.safeParse(profile);
  const errors = r.success ? {} : fieldErrors(r.error.issues);
  const bind = (k: keyof Profile, clean = (v: string) => v) => ({ value: profile[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...profile, [k]: clean(e.target.value) }) });
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name" hint="Matched against Linear authors to show you as “You”." error={errors.name}>
          {(p) => <Input {...p} {...bind("name")} placeholder="Aziz Khan" />}
        </Field>
        <Field label="Handle" hint="Others @mention you with this." error={errors.handle}>
          {(p) => <Input {...p} {...bind("handle", (v) => v.replace(/^@/, "").toLowerCase())} placeholder="@aziz" className="font-mono" />}
        </Field>
        <Field label="GitHub username" error={errors.githubUsername}>
          {(p) => <Input {...p} {...bind("githubUsername")} placeholder="octocat" className="font-mono" />}
        </Field>
        <Field label="GitHub email" hint="Author of Zipper commits." error={errors.githubEmail}>
          {(p) => <Input {...p} {...bind("githubEmail")} type="email" placeholder="you@example.com" />}
        </Field>
        <Field label="Linear username" hint="Lists your issues in Linear.">
          {(p) => <Input {...p} {...bind("linearUser")} placeholder="aziz" />}
        </Field>
        <Field label="Role" hint="Told to Zippers." error={errors.role}>
          {(p) => <Input {...p} {...bind("role")} placeholder="Backend engineer" />}
        </Field>
      </div>
      <Field label="About you" hint="Working style Zippers should know: preferred PR size, stack, review habits." error={errors.about}>
        {(p) => <Textarea {...p} value={profile.about} onChange={(e) => onChange({ ...profile, about: e.target.value })} rows={3} />}
      </Field>
    </>
  );
}
