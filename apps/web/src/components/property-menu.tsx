import { CheckIcon as Check } from "@/components/ui/check";
import { PlusIcon as Plus } from "@/components/ui/plus";
import { useState, type ReactNode } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";

export type MenuOption = { value: string; label: string; icon?: ReactNode; group?: string };

type Props = {
  options: MenuOption[];
  placeholder: string; // search box text, e.g. "Change status…"
  trigger: ReactNode;
  triggerLabel: string; // accessible name for the trigger
  id?: string;
  numbered?: boolean; // show 1-9 pick hints (default on)
  contentClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreate?: (name: string) => void; // shows "Create …" for unmatched search text
  align?: "start" | "end";
  className?: string;
} & ({ multi?: false; value: string | null; onChange: (v: string) => void } | { multi: true; value: string[]; onChange: (v: string[]) => void });

/** Linear-style property picker: searchable popover, number keys pick the first nine options. */
export function PropertyMenu(props: Props) {
  const [innerOpen, setInnerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const open = props.open ?? innerOpen;
  const setOpen = (o: boolean) => {
    (props.onOpenChange ?? setInnerOpen)(o);
    if (!o) setSearch("");
  };
  const selected = (v: string) => (props.multi ? props.value.includes(v) : props.value === v);

  function pick(v: string) {
    if (props.multi) props.onChange(selected(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    else {
      props.onChange(v);
      setOpen(false);
    }
  }

  const groups = [...new Set(props.options.map((o) => o.group ?? ""))];
  const canCreate = props.onCreate && search.trim() && !props.options.some((o) => o.label.toLowerCase() === search.trim().toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        aria-label={props.triggerLabel}
        className={cn(
          "hover:bg-primary/[0.08] focus-visible:ring-ring/60 data-[state=open]:bg-primary/[0.12] flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none transition-colors focus-visible:ring-2",
          props.className,
        )}
      >
        {props.trigger}
      </PopoverTrigger>
      <PopoverContent align={props.align ?? "start"} className={cn("w-64 p-0", props.contentClassName)}>
        <Command
          onKeyDown={(e) => {
            if (props.numbered !== false && !search && /^[1-9]$/.test(e.key)) {
              const o = props.options[Number(e.key) - 1];
              if (o) (e.preventDefault(), pick(o.value));
            }
          }}
        >
          <CommandInput placeholder={props.placeholder} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No results</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g} heading={g || undefined}>
                {props.options.map((o, i) => (o.group ?? "") === g && (
                <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => pick(o.value)} className="gap-2 text-[13px]">
                  {props.multi && (
                    <span className={cn("flex size-3.5 items-center justify-center rounded-[3px] border", selected(o.value) && "border-primary bg-primary text-white")} aria-hidden>
                      {selected(o.value) && <Check className="size-2.5" />}
                    </span>
                  )}
                  {o.icon}
                  <span className="flex-1 truncate">{o.label}</span>
                  {!props.multi && selected(o.value) && <Check className="size-3.5" aria-label="selected" />}
                  {props.numbered !== false && i < 9 && <span className="text-muted-foreground text-xs tabular-nums">{i + 1}</span>}
                </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {canCreate && (
              <CommandGroup>
                <CommandItem value={`create ${search}`} onSelect={() => (props.onCreate!(search.trim()), setSearch(""))} className="gap-2 text-[13px]">
                  <Plus className="size-3.5" aria-hidden /> Create “{search.trim()}”
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Form select: searchable PropertyMenu with an input-style trigger. Replaces native/Radix selects. */
export function OptionSelect({ value, onChange, options, label, id, placeholder, size = "default", className }: { value: string; onChange: (v: string) => void; options: MenuOption[]; label: string; id?: string; placeholder?: string; size?: "sm" | "default"; className?: string }) {
  const sel = options.find((o) => o.value === value);
  return (
    <PropertyMenu
      id={id}
      numbered={false}
      value={value}
      onChange={onChange}
      options={options}
      triggerLabel={label}
      placeholder={placeholder ?? `Search ${label.toLowerCase()}…`}
      contentClassName="w-(--radix-popover-trigger-width) min-w-44"
      className={cn("border-input dark:bg-input/30 w-full justify-between gap-1.5 border bg-transparent text-sm", size === "sm" ? "h-7" : "h-8", className)}
      trigger={
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            {sel?.icon}
            <span className="truncate">{sel?.label ?? value}</span>
          </span>
          <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0" aria-hidden />
        </>
      }
    />
  );
}
