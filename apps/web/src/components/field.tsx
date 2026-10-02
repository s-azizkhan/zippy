import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";

/** Label + control + hint/error, wired with aria-describedby. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode }) {
  const id = useId();
  const descId = hint || error ? `${id}-desc` : undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[13px]">
        {label}
      </Label>
      {children({ id, "aria-describedby": descId, "aria-invalid": !!error || undefined })}
      {(error || hint) && (
        <p id={descId} className={error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/** Switch-style row: label + hint on the left, control on the right. */
export function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: (props: { "aria-labelledby": string; "aria-describedby"?: string }) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-[13px] font-medium">
          {label}
        </p>
        {hint && (
          <p id={`${id}-desc`} className="text-muted-foreground text-xs">
            {hint}
          </p>
        )}
      </div>
      {children({ "aria-labelledby": `${id}-label`, "aria-describedby": hint ? `${id}-desc` : undefined })}
    </div>
  );
}

/** First zod issue per top-level field. */
export const fieldErrors = (issues: { path: PropertyKey[]; message: string }[]) =>
  Object.fromEntries(issues.toReversed().map((i) => [String(i.path[0]), i.message])) as Record<string, string>;
