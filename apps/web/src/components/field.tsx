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

/** First zod issue per top-level field. */
export const fieldErrors = (issues: { path: PropertyKey[]; message: string }[]) =>
  Object.fromEntries(issues.toReversed().map((i) => [String(i.path[0]), i.message])) as Record<string, string>;
