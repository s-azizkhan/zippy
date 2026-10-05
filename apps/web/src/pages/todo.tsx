import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Clock, Paperclip, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Link } from "react-router";
import { workDay } from "@zippy/shared";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import { useLinearIssue } from "@/components/linear-issues";
import { MdEditor } from "@/components/md-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, keys, useApiMutation, useTickets, useTodos, type Todo } from "@/lib/api";
import { useOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const shift = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return workDay(new Date(y!, m! - 1, d! + n, 12), "00:00");
};
const label = (day: string, today: string) =>
  day === today ? "Today" : day === shift(today, -1) ? "Yesterday" : new Date(`${day}T12:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

async function upload(file: File, editor: Editor) {
  const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  const { url } = (await res.json()) as { url: string };
  const c = editor.chain().focus();
  (/^image\/(png|jpeg|gif|webp)$/.test(file.type) ? c.setImage({ src: url, alt: file.name }) : c.insertContent({ type: "text", text: file.name, marks: [{ type: "link", attrs: { href: url } }] })).run();
}

function RefChip({ ref: id }: { ref: string }) {
  const org = useOrg();
  const { data: tickets = [] } = useTickets(org.id);
  const own = tickets.find((t) => t.identifier === id);
  const { data: linear } = useLinearIssue(org.id, org.linearConnected && !own ? id : null);
  const title = own?.title ?? linear?.title;
  const cls = "bg-muted hover:bg-accent inline-flex max-w-[9rem] shrink-0 items-center sm:max-w-xs gap-1.5 rounded-md px-1.5 py-0.5 text-xs";
  const text = (
    <>
      <span className="font-mono">{id}</span>
      {title && <span className="text-muted-foreground truncate">{title}</span>}
    </>
  );
  return own ? (
    <Link to={`/t/${id}`} className={cls}>{text}</Link>
  ) : (
    // Linear links open in the in-app issue modal (see LinearIssueModal)
    <a href={`https://linear.app/${org.linearWorkspace ?? "issue"}/issue/${id}`} target="_blank" rel="noreferrer" className={cls}>{text}</a>
  );
}

/** Pick a Zippy issue, or type a Linear ID like COM-768. */
function RefPicker({ value, onChange, onTitle }: { value: string; onChange: (ref: string) => void; onTitle: (t: string) => void }) {
  const org = useOrg();
  const { data: tickets = [] } = useTickets(org.id);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const hits = tickets.filter((t) => `${t.identifier} ${t.title}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const pick = (ref: string, title = "") => (onChange(ref), title && onTitle(title), setOpen(false), setQ(""));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="max-w-32 shrink-0 truncate font-mono">{value || "Link issue"}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <Input autoFocus placeholder="Search issues or type a Linear ID" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ID_RE.test(q.trim()) && (e.preventDefault(), pick(q.trim().toUpperCase()))} />
        <ul className="mt-2 max-h-64 overflow-y-auto">
          {ID_RE.test(q.trim()) && !hits.some((t) => t.identifier === q.trim().toUpperCase()) && (
            <li><button type="button" className="hover:bg-accent w-full rounded-md px-2 py-1.5 text-left text-[13px]" onClick={() => pick(q.trim().toUpperCase())}>Use <span className="font-mono">{q.trim().toUpperCase()}</span> (Linear)</button></li>
          )}
          {hits.map((t) => (
            <li key={t.id}><button type="button" className="hover:bg-accent flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-[13px]" onClick={() => pick(t.identifier, t.title)}>
              <span className="text-muted-foreground font-mono">{t.identifier}</span><span className="truncate">{t.title}</span>
            </button></li>
          ))}
          {value && <li><button type="button" className="text-muted-foreground hover:bg-accent w-full rounded-md px-2 py-1.5 text-left text-[13px]" onClick={() => pick("")}>Clear link</button></li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function TodoItem({ todo, readOnly }: { todo: Todo; readOnly: boolean }) {
  const org = useOrg();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(todo.bodyMd);
  const [editor, setEditor] = useState<Editor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const file = useRef<HTMLInputElement>(null);
  const save = async (patch: Partial<Todo>) => {
    await api.patch(`/todos/${todo.id}`, patch, true);
    qc.setQueryData<Todo[]>(keys.res(org.id, "todos"), (l) => l?.map((t) => (t.id === todo.id ? { ...t, ...patch } : t)));
  };
  const remove = useApiMutation(() => api.del(`/todos/${todo.id}`), [keys.res(org.id, "todos")]);
  const edit = (md: string) => (setBody(md), clearTimeout(timer.current), (timer.current = setTimeout(() => save({ bodyMd: md }), 600)));
  const attach = (files: FileList | File[]) => editor && [...files].forEach((f) => upload(f, editor).catch((e: Error) => toast.error(e.message)));
  return (
    <li className="bg-card min-w-0 rounded-xl border">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <input type="checkbox" checked={todo.done} disabled={readOnly} onChange={(e) => save({ done: e.target.checked })} className="size-4 accent-[#f472b6]" aria-label="Done" />
        <button type="button" onClick={() => setOpen(!open)} className={cn("min-w-0 flex-1 truncate text-left text-sm", todo.done && "text-muted-foreground line-through")}>{todo.title}</button>
        {todo.ref && <RefChip ref={todo.ref} />}
        <button type="button" onClick={() => setOpen(!open)} aria-label="Toggle notes" className="text-muted-foreground hover:text-foreground"><ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} /></button>
        {!readOnly && <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive size-7" onClick={() => remove.mutate(undefined)} aria-label="Delete"><Trash2 aria-hidden /></Button>}
      </div>
      {open && (
        <div className="min-w-0 overflow-x-auto border-t px-3 py-3 [&_img]:max-w-full" onDragOver={(e) => e.preventDefault()}
          onDropCapture={(e) => e.dataTransfer.files.length && (e.preventDefault(), attach(e.dataTransfer.files))}
          onPasteCapture={(e) => e.clipboardData.files.length && (e.preventDefault(), attach(e.clipboardData.files))}>
          {readOnly ? (
            <div className="md text-sm"><Markdown>{body || "_No notes._"}</Markdown></div>
          ) : (
            <>
              <MdEditor value={body} onChange={edit} onBlur={(md) => (clearTimeout(timer.current), save({ bodyMd: md }))} onEditor={setEditor} placeholder="Notes… type / for blocks, paste or drop images and PDFs" label="Notes" className="min-h-24 text-sm" />
              <input ref={file} type="file" multiple hidden onChange={(e) => (attach(e.target.files!), (e.target.value = ""))} />
              <Button variant="ghost" size="sm" className="text-muted-foreground mt-2" onClick={() => file.current?.click()}><Paperclip aria-hidden /> Attach</Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function TodoPage() {
  const org = useOrg();
  const dayStart = org.profile.dayStart ?? "00:00";
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const today = workDay(now, dayStart);
  const [picked, setDay] = useState<string | null>(null);
  const day = picked ?? today;
  const { data: all = [] } = useTodos(org.id);
  const list = all.filter((t) => t.day === day);
  const readOnly = day < today;
  const [title, setTitle] = useState("");
  const [ref, setRef] = useState("");
  const add = useApiMutation(
    () => api.post(`/orgs/${org.id}/todos`, { day, title, ref }, true).then(() => (setTitle(""), setRef(""))),
    [keys.res(org.id, "todos")],
  );
  const saveStart = useApiMutation((v: string) => api.patch(`/orgs/${org.id}`, { profile: { ...org.profile, dayStart: v } }), [keys.orgs]);
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setDay(shift(day, -1))} aria-label="Previous day"><ChevronLeft aria-hidden /></Button>
            <h1 className="min-w-32 text-center text-xl font-semibold tracking-tight">{label(day, today)}</h1>
            <Button variant="ghost" size="icon" onClick={() => setDay(shift(day, 1))} disabled={day >= today} aria-label="Next day"><ChevronRight aria-hidden /></Button>
            {day !== today && <Button variant="outline" size="sm" onClick={() => setDay(null)}>Today</Button>}
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground"><Clock aria-hidden /> Day starts {dayStart}</Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <label className="grid gap-2 text-sm">
                Day starts at
                <Input type="time" value={dayStart} onChange={(e) => e.target.value && saveStart.mutate(e.target.value)} />
                <span className="text-muted-foreground text-xs">Your day runs from this time to the same time tomorrow. Earlier days move to the past.</span>
              </label>
            </PopoverContent>
          </Popover>
        </header>

        {!readOnly && (
          <form className="mb-4 flex min-w-0 gap-2" onSubmit={(e) => (e.preventDefault(), title.trim() && add.mutate(undefined))}>
            <Input className="min-w-0" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What are you working on?" aria-label="New todo" />
            <RefPicker value={ref} onChange={setRef} onTitle={(t) => !title && setTitle(t)} />
            <Button type="submit" disabled={!title.trim() || add.isPending}>Add</Button>
          </form>
        )}

        {list.length ? (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">{list.map((t) => <TodoItem key={t.id} todo={t} readOnly={readOnly} />)}</ul>
        ) : (
          <p className="text-muted-foreground py-16 text-center text-sm">{readOnly ? "Nothing logged this day." : "Nothing planned yet."}</p>
        )}
      </div>
    </div>
  );
}
