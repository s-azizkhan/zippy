import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Code, Heading1, Heading2, Heading3, Heading4, List, ListOrdered, ListTodo, Minus, Quote, Table } from "lucide-react";
import { Extension, type Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { cn } from "@/lib/utils";

const lowlight = createLowlight(common);

type Cmd = { title: string; hint: string; keywords: string; icon: ComponentType<{ className?: string }>; run: (e: Editor) => void };
const heading = (level: 1 | 2 | 3 | 4) => (e: Editor) => e.chain().focus().setHeading({ level }).run();
const COMMANDS: Cmd[] = [
  { title: "Heading 1", hint: "Big section title", keywords: "h1 title", icon: Heading1, run: heading(1) },
  { title: "Heading 2", hint: "Section title", keywords: "h2", icon: Heading2, run: heading(2) },
  { title: "Heading 3", hint: "Sub-section", keywords: "h3", icon: Heading3, run: heading(3) },
  { title: "Heading 4", hint: "Small heading", keywords: "h4", icon: Heading4, run: heading(4) },
  { title: "Bullet list", hint: "Unordered list", keywords: "ul unordered dots", icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { title: "Numbered list", hint: "Ordered list", keywords: "ol ordered 1.", icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { title: "Task list", hint: "Checklist with checkboxes", keywords: "todo checkbox check", icon: ListTodo, run: (e) => e.chain().focus().toggleTaskList().run() },
  { title: "Quote", hint: "Block quote", keywords: "blockquote cite", icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { title: "Code block", hint: "Monospace code", keywords: "pre snippet", icon: Code, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { title: "Divider", hint: "Horizontal rule", keywords: "hr line separator", icon: Minus, run: (e) => e.chain().focus().setHorizontalRule().run() },
  { title: "Table", hint: "3 × 3 table", keywords: "grid", icon: Table, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
];

type Slash = { items: Cmd[]; range: Range; rect: DOMRect | null; index: number; editor: Editor };

/** Markdown in, markdown out, always shown rendered (same `.md` look as the read view). */
export function MdEditor({ value, onChange, onBlur, onKeyDown, onEditor, placeholder, label, id, className, autoFocus, boxed = true }: {
  value: string;
  onChange?: (md: string) => void;
  onBlur?: (md: string) => void;
  onKeyDown?: (e: KeyboardEvent) => boolean | void;
  onEditor?: (editor: Editor) => void;
  placeholder?: string;
  label?: string;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  boxed?: boolean;
}) {
  const cb = useRef({ onChange, onBlur, onKeyDown });
  useEffect(() => {
    cb.current = { onChange, onBlur, onKeyDown };
  });
  const [slash, setSlash] = useState<Slash | null>(null);
  const slashRef = useRef<Slash | null>(null);
  useEffect(() => {
    slashRef.current = slash;
  });
  const extensions = useMemo(() => {
    const show = (p: { items: Cmd[]; range: Range; clientRect?: (() => DOMRect | null) | null; editor: Editor }, index = 0) =>
      setSlash(p.items.length ? { items: p.items, range: p.range, rect: p.clientRect?.() ?? null, index, editor: p.editor } : null);
    const SlashMenu = Extension.create({
      name: "slashMenu",
      addProseMirrorPlugins() {
        return [
          Suggestion<Cmd, Cmd>({
            editor: this.editor,
            char: "/",
            startOfLine: true,
            items: ({ query }) => COMMANDS.filter((c) => `${c.title} ${c.keywords}`.toLowerCase().includes(query.toLowerCase())),
            command: ({ editor, range, props }) => (editor.chain().focus().deleteRange(range).run(), props.run(editor)),
            render: () => ({
              onStart: (p) => show(p),
              onUpdate: (p) => show(p),
              onExit: () => setSlash(null),
              onKeyDown: ({ event }) => {
                const cur = slashRef.current;
                if (!cur) return false;
                if (event.key === "Escape") return setSlash(null), true;
                if (event.key === "Enter" || event.key === "Tab") return cur.items[cur.index] && (setSlash(null), cur.editor.chain().focus().deleteRange(cur.range).run(), cur.items[cur.index]!.run(cur.editor)), true;
                const d = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                if (!d) return false;
                setSlash({ ...cur, index: (cur.index + d + cur.items.length) % cur.items.length });
                return true;
              },
            }),
          }),
        ];
      },
    });
    return [StarterKit.configure({ codeBlock: false }), CodeBlockLowlight.configure({ lowlight }), Markdown, Image, TableKit, TaskList, TaskItem.configure({ nested: true }), Placeholder.configure({ placeholder }), SlashMenu];
  }, [placeholder]);
  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: cn("md min-h-full outline-none", className), role: "textbox", "aria-multiline": "true", ...(label && { "aria-label": label }), ...(id && { id }) },
      handleKeyDown: (_, e) => !!cb.current.onKeyDown?.(e),
    },
    onUpdate: ({ editor }) => cb.current.onChange?.(editor.getMarkdown()),
    onBlur: ({ editor }) => cb.current.onBlur?.(editor.getMarkdown()),
  });
  useEffect(() => {
    if (editor) onEditor?.(editor);
  }, [editor, onEditor]);
  useEffect(() => {
    if (editor && value !== editor.getMarkdown()) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);
  const host = slash ? (slash.editor.view.dom.closest("[role=dialog]") ?? document.body) : null;
  const origin = host && host !== document.body ? host.getBoundingClientRect() : { left: 0, top: 0, bottom: innerHeight };
  const flip = !!slash?.rect && slash.rect.bottom + 300 > innerHeight;
  return (
    <>
      <EditorContent editor={editor} className={boxed ? "border-input focus-within:border-ring focus-within:ring-ring/50 rounded-lg border px-3 py-2 text-[14px] focus-within:ring-[3px] dark:bg-input/30" : undefined} />
      {slash && host && createPortal(
        <ul role="listbox" aria-label="Insert" className="bg-popover fixed z-[100] max-h-72 w-64 overflow-y-auto rounded-lg border p-1 shadow-lg"
          style={{ left: (slash.rect?.left ?? 0) - origin.left, ...(flip ? { bottom: origin.bottom - (slash.rect?.top ?? 0) + 6 } : { top: (slash.rect?.bottom ?? 0) - origin.top + 6 }) }}>
          {slash.items.map((c, i) => (
            <li key={c.title} role="option" aria-selected={i === slash.index} ref={(el) => void (i === slash.index && el?.scrollIntoView({ block: "nearest" }))}
              onMouseDown={(e) => (e.preventDefault(), setSlash(null), slash.editor.chain().focus().deleteRange(slash.range).run(), c.run(slash.editor))}
              className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px]", i === slash.index && "bg-accent")}>
              <c.icon className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0"><span className="block">{c.title}</span><span className="text-muted-foreground block truncate text-xs">{c.hint}</span></span>
            </li>
          ))}
        </ul>,
        host,
      )}
    </>
  );
}
