import { App, TFile } from "obsidian";
import { resolve } from "./path-utils";

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
  // Don't quote markdown links like ![](path) or [[path]]
  if (/^!\[.*?\]\(.*?\)$/.test(v) || /^\[\[.*?\]\]$/.test(v)) return v;
  // Quote values that start with special YAML characters or contain problematic patterns
  if (/[#%&*{},|>`"']/.test(v[0]) || /:\s/.test(v) || /\s#/.test(v))
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
): Promise<Record<string, unknown> | null> {
  const c = app.metadataCache.getFileCache(f);
  if (c?.frontmatter) return c.frontmatter;
  try {
    return parseFM(await app.vault.cachedRead(f));
  } catch {
    return null;
  }
}

export async function writeFM(
  app: App,
  f: TFile,
  upd: Record<string, string>,
): Promise<boolean> {
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
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
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
// Index helpers (for frontmatter reverse lookup)
// ══════════════════════════════════════════════════════════════

export function extractResolvedPaths(
  fm: Record<string, unknown>,
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
    if (resolved) result.set(field, resolved);
  }
  return result;
}
