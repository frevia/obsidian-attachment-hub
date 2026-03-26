import { App, TFile, normalizePath } from "obsidian";
import * as nodeCrypto from "crypto";
import {
  AttachmentHubSettings,
  AttachPathSettings,
  effectiveSetting,
  ROOT_OBS,
  ROOT_IN,
  ROOT_NEXT,
} from "./settings";

// ══════════════════════════════════════════════════════════════
// Path utilities
// ══════════════════════════════════════════════════════════════

export function pDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.substring(0, i);
}
export function pBase(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.substring(i + 1);
}
export function pExt(p: string): string {
  const b = pBase(p), i = b.lastIndexOf(".");
  return i < 0 ? "" : b.substring(i + 1);
}
export function pStem(p: string): string {
  const b = pBase(p), i = b.lastIndexOf(".");
  return i < 0 ? b : b.substring(0, i);
}
export function pDotExt(p: string): string {
  const b = pBase(p), i = b.lastIndexOf(".");
  return i < 0 ? "" : b.substring(i);
}

export function pJoin(...parts: string[]): string {
  const s: string[] = [];
  for (const p of parts) {
    for (const seg of p.split("/")) {
      if (seg === "..") s.pop();
      else if (seg && seg !== ".") s.push(seg);
    }
  }
  return s.join("/");
}

export function resolve(fromDir: string, rel: string): string | null {
  if (!rel || rel.startsWith("http://") || rel.startsWith("https://")) return null;
  const s = fromDir ? fromDir.split("/") : [];
  for (const p of rel.split("/")) {
    if (p === "..") s.pop();
    else if (p !== "." && p) s.push(p);
  }
  return normalizePath(s.join("/"));
}

export function relative(fromDir: string, toPath: string): string {
  const f = fromDir ? fromDir.split("/") : [];
  const t = toPath.split("/");
  let c = 0;
  while (c < f.length && c < t.length && f[c] === t[c]) c++;
  const p: string[] = [];
  for (let i = 0; i < f.length - c; i++) p.push("..");
  p.push(...t.slice(c));
  return p.join("/");
}

// ══════════════════════════════════════════════════════════════
// MD5
// ══════════════════════════════════════════════════════════════

export async function md5sum(adapter: any, file: TFile): Promise<string> {
  try {
    const buf = await adapter.readBinary(file.path);
    return nodeCrypto.createHash("md5").update(Buffer.from(buf)).digest("hex").toUpperCase();
  } catch (_) {
    return "";
  }
}

// ══════════════════════════════════════════════════════════════
// Variable substitution & path resolution
// ══════════════════════════════════════════════════════════════

interface VarContext {
  dateFormat?: string;
  noteName?: string;
  noteDir?: string;
  parentName?: string;
  origName?: string;
  md5?: string;
}

export function resolveVars(template: string, ctx: VarContext): string {
  const d = (window as any).moment
    ? (window as any).moment().format(ctx.dateFormat || "YYYYMMDDHHmmssSSS")
    : Date.now().toString();
  return template
    .replace(/\$\{date\}/g, d)
    .replace(/\$\{notename\}/g, ctx.noteName || "")
    .replace(/\$\{notepath\}/g, ctx.noteDir || "")
    .replace(/\$\{parent\}/g, ctx.parentName || "")
    .replace(/\$\{originalname\}/g, ctx.origName || "")
    .replace(/\$\{md5\}/g, ctx.md5 || "");
}

export function getRootPath(noteDir: string, setting: any, obsFolder: string): string {
  switch (setting.saveAttE) {
    case ROOT_IN:
      return normalizePath(setting.attachmentRoot || "");
    case ROOT_NEXT:
      return normalizePath(pJoin(noteDir, (setting.attachmentRoot || "").replace(/^\.\//, "")));
    default:
      if (!obsFolder || obsFolder === "/") return obsFolder === "/" ? "" : "";
      if (obsFolder === "./") return noteDir;
      if (obsFolder.startsWith("./"))
        return normalizePath(pJoin(noteDir, obsFolder.replace(/^\.\//, "")));
      return normalizePath(obsFolder);
  }
}

export function computeAttachPath(
  noteFile: TFile,
  attachExt: string | null,
  setting: AttachPathSettings,
  dateFormat: string,
  obsFolder: string,
): string {
  const noteDir = pDir(noteFile.path);
  const eff = effectiveSetting(setting, attachExt);
  const root = getRootPath(noteDir, eff, obsFolder);
  const sub = resolveVars(eff.attachmentPath || "", {
    dateFormat,
    noteName: pStem(noteFile.path),
    noteDir,
    parentName: pBase(noteDir),
  });
  return normalizePath(pJoin(root, sub));
}

export async function computeAttachName(
  noteFile: TFile,
  attachFile: TFile | null,
  setting: AttachPathSettings,
  dateFormat: string,
  adapter: any,
  fallbackName?: string,
): Promise<string> {
  const eff = effectiveSetting(setting, attachFile ? pExt(attachFile.path) : null);
  const fmt = eff.attachFormat || "img-${date}";
  const noteName = pStem(noteFile.path);
  const md5Val = attachFile ? await md5sum(adapter, attachFile) : "";

  if (fmt.includes("${originalname}")) {
    const origName = attachFile ? pStem(attachFile.path) : "";
    if (!origName && fallbackName) return fallbackName;
    return resolveVars(fmt, { dateFormat, noteName, noteDir: "", parentName: "", origName, md5: md5Val });
  }
  return resolveVars(fmt, { dateFormat, noteName, noteDir: "", parentName: "", origName: "", md5: md5Val });
}

// ══════════════════════════════════════════════════════════════
// Deduplication
// ══════════════════════════════════════════════════════════════

export async function dedup(name: string, folderPath: string, adapter: any): Promise<string> {
  let listed;
  try {
    listed = await adapter.list(folderPath);
  } catch (_) {
    return name;
  }
  const dotExt = pDotExt(name);
  const stem = name.slice(0, name.length - dotExt.length);
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}-(\\d{1,3})\\${dotExt}$`);
  let exists = false;
  const nums: number[] = [];
  for (let sib of listed.files) {
    sib = pBase(sib);
    if (sib === name) {
      exists = true;
      continue;
    }
    const m = re.exec(sib);
    if (m) nums.push(parseInt(m[1]));
  }
  if (exists) return `${stem}-${nums.length ? Math.max(...nums) + 1 : 1}${dotExt}`;
  return name;
}

// ══════════════════════════════════════════════════════════════
// Frontmatter I/O
// ══════════════════════════════════════════════════════════════

const RE_FM = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseFM(content: string): Record<string, string> | null {
  const m = content.match(RE_FM);
  if (!m) return null;
  const r: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const k = line.substring(0, ci).trim();
    let v = line.substring(ci + 1).trim();
    if (
      (v[0] === '"' && v[v.length - 1] === '"') ||
      (v[0] === "'" && v[v.length - 1] === "'")
    )
      v = v.slice(1, -1);
    if (k && k[0] !== " " && k[0] !== "-") r[k] = v;
  }
  return r;
}

export function fmSection(content: string): string | null {
  const m = content.match(RE_FM);
  return m ? m[1] : null;
}

export function yamlSafe(v: string): string {
  if (!v) return '""';
  if (/[!#%&*?,\[\]{}|>@`"']/.test(v[0]) || /:\s/.test(v) || /\s#/.test(v))
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return v;
}

export function replaceFMField(content: string, key: string, val: string): string {
  const m = content.match(RE_FM);
  if (!m) return content;
  const lines = m[1].split(/\r?\n/);
  let found = false;
  const s = yamlSafe(val);
  for (let i = 0; i < lines.length; i++) {
    const ci = lines[i].indexOf(":");
    if (ci >= 0 && lines[i].substring(0, ci).trim() === key) {
      lines[i] = `${key}: ${s}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}: ${s}`);
  return content.replace(RE_FM, `---\n${lines.join("\n")}\n---`);
}

export async function getFM(
  app: App,
  f: TFile,
): Promise<Record<string, any> | null> {
  const c = app.metadataCache.getFileCache(f);
  if (c?.frontmatter) return c.frontmatter;
  try {
    return parseFM(await app.vault.cachedRead(f));
  } catch (_) {
    return null;
  }
}

export async function writeFM(
  app: App,
  f: TFile,
  upd: Record<string, string>,
): Promise<boolean> {
  if (f.extension === "md") {
    try {
      await app.fileManager.processFrontMatter(f, (fm: Record<string, any>) => {
        for (const [k, v] of Object.entries(upd)) fm[k] = v;
      });
      return true;
    } catch (_) {}
  }
  try {
    let c = await app.vault.read(f);
    for (const [k, v] of Object.entries(upd)) c = replaceFMField(c, k, v);
    await app.vault.modify(f, c);
    return true;
  } catch (e) {
    console.error("[AttachHub]", f.path, e);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// Link format (for frontmatter values)
// ══════════════════════════════════════════════════════════════

const RE_MDL = /^!\[.*?\]\((.*?)\)$/;
const RE_WL = /^!\[\[(.*?)(?:\|.*)?\]\]$/;
const RE_WL2 = /^\[\[(.*?)(?:\|.*)?\]\]$/;

export function stripLink(v: string): string | null {
  if (typeof v !== "string") return null;
  let m = v.match(RE_MDL);
  if (m) return decodeURIComponent(m[1]);
  m = v.match(RE_WL);
  if (m) return m[1];
  m = v.match(RE_WL2);
  if (m) return m[1];
  return null;
}

export function fmtPath(plain: string, fmt: string): string {
  if (!plain) return "";
  if (fmt === "markdown") return `![](${plain})`;
  if (fmt === "wikilink") return `![[${plain}]]`;
  return plain;
}

// ══════════════════════════════════════════════════════════════
// Clipboard & Folder helpers
// ══════════════════════════════════════════════════════════════

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

export async function clipImage(): Promise<{ buf: ArrayBuffer; ext: string } | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      for (const t of item.types) {
        if (t.startsWith("image/")) {
          const b = await item.getType(t);
          return { buf: await b.arrayBuffer(), ext: MIME_EXT[t] || "png" };
        }
      }
    }
  } catch (_) {}
  return null;
}

export async function ensureFolder(adapter: any, p: string): Promise<void> {
  if (p && !(await adapter.exists(p, true))) await adapter.mkdir(p);
}

export async function isEmptyFolder(adapter: any, p: string): Promise<boolean> {
  if (!p) return false;
  try {
    const l = await adapter.list(p);
    return !l.files.length && !l.folders.length;
  } catch (_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// Index helpers (for frontmatter reverse lookup)
// ══════════════════════════════════════════════════════════════

export function extractResolvedPaths(
  fm: Record<string, any>,
  trackedFields: string[],
  noteDir: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const field of trackedFields) {
    const val = fm[field];
    if (typeof val !== "string" || !val) continue;
    const plain = stripLink(val) || val;
    if (plain.startsWith("http://") || plain.startsWith("https://")) continue;
    const resolved = resolve(noteDir, plain);
    if (resolved) result.set(field, normalizePath(resolved));
  }
  return result;
}
