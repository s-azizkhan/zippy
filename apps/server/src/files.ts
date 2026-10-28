import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Linear upload URLs are signed for ~5 minutes, so images are copied here at sync time.
export const FILES_DIR = join(homedir(), ".zippy", "files");
export const UPLOADS_DIR = join(FILES_DIR, "uploads");
export const FILE_KEY_RE = /^[a-f0-9]{32}\.(png|jpg|gif|webp|bin)$/;

// No SVG: it can carry script and would run on Zippy's origin.
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

async function cache(src: string): Promise<string | null> {
  if (!src.startsWith("https://uploads.linear.app/")) return null; // ticket text is untrusted: never fetch arbitrary URLs
  const id = createHash("sha256").update(src.split("?")[0]!).digest("hex").slice(0, 32);
  for (const ext of [...Object.values(EXT), "bin"]) if (existsSync(join(FILES_DIR, `${id}.${ext}`))) return `${id}.${ext}`;
  const res = await fetch(src).catch(() => null);
  if (!res?.ok) return null;
  const key = `${id}.${EXT[res.headers.get("content-type")?.split(";")[0] ?? ""] ?? "bin"}`;
  await mkdir(FILES_DIR, { recursive: true });
  await writeFile(join(FILES_DIR, key), Buffer.from(await res.arrayBuffer()));
  return key;
}

const LINEAR_IMAGE = /<linear-image>(\{.*?\})<\/linear-image>/gs;
const LINEAR_ISSUE = /<issue\b[^>]*?\bhref="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/issue>/gs;
const LINEAR_USER = /<user\b[^>]*>(.*?)<\/user>/gs;
const MD_UPLOAD = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;

/** Rewrite Linear image embeds to markdown images served from the local cache. Unfetchable images stay as links. */
export async function localizeImages(text: string): Promise<string> {
  const found: { match: string; src: string; alt: string }[] = [];
  for (const m of text.matchAll(LINEAR_IMAGE)) {
    try {
      const { attrs } = JSON.parse(m[1]!) as { attrs: { src: string; title?: string; alt?: string } };
      found.push({ match: m[0], src: attrs.src, alt: attrs.alt ?? attrs.title ?? "image" });
    } catch {
      // Not the JSON shape we know; leave the tag as text.
    }
  }
  text = text.replace(LINEAR_ISSUE, "[$2]($1)").replace(LINEAR_USER, "**@$1**");
  for (const m of text.matchAll(MD_UPLOAD)) found.push({ match: m[0], src: m[2]!, alt: m[1] || "image" });
  for (const f of found) {
    const key = await cache(f.src);
    text = text.replace(f.match, key ? `![${f.alt}](/api/files/${key})` : `[${f.alt}](${f.src.split("?")[0]})`);
  }
  return text;
}

/** Agents read images from disk: point cached image links at local paths. */
export const forAgent = (text: string) => text.replaceAll("](/api/files/", `](${FILES_DIR}/`);

export async function readCached(key: string) {
  if (!FILE_KEY_RE.test(key)) return null;
  const path = join(FILES_DIR, key);
  if (!existsSync(path)) return null;
  return { body: await readFile(path), type: TYPE[key.split(".")[1]!] ?? "application/octet-stream" };
}

// User uploads (any type). Only raster images and PDF render inline; everything else downloads, so uploaded HTML/SVG never runs on Zippy's origin.
const UPLOAD_RE = /^[a-f0-9]{32}-[\w.-]{1,100}$/;
const INLINE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

export async function saveUpload(name: string, body: ArrayBuffer) {
  const key = `${randomUUID().replaceAll("-", "")}-${name.replace(/[^\w.-]/g, "_").slice(-100) || "file"}`;
  await mkdir(UPLOADS_DIR, { recursive: true });
  await writeFile(join(UPLOADS_DIR, key), Buffer.from(body));
  return { key, inline: key.split(".").pop()!.toLowerCase() in INLINE };
}

export async function readUpload(key: string) {
  if (!UPLOAD_RE.test(key) || !existsSync(join(UPLOADS_DIR, key))) return null;
  const type = INLINE[key.split(".").pop()!.toLowerCase()];
  return { body: await readFile(join(UPLOADS_DIR, key)), type: type ?? "application/octet-stream", name: key.slice(33), inline: !!type };
}
