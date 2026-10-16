import { App, parseYaml, stringifyYaml, TFile } from "obsidian";
import { resolve } from "./path-utils";

// ══════════════════════════════════════════════════════════════
// Frontmatter I/O
// ══════════════════════════════════════════════════════════════

const RE_FM = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?=\r?\n|$)/;

export function parseFM(content: string): Record<string, unknown> | null {
  const section = fmSection(content);
  if (section === null) return null;
  const parsed: unknown = section.trim() ? parseYaml(section) : {};
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

export function fmSection(content: string): string | null {
  const m = content.match(RE_FM);
  return m ? m[1] || "" : null;
}

export function replaceFMField(content: string, key: string, val: string): string {
  const m = content.match(RE_FM);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const fm = m ? parseFM(content) : {};
  if (fm === null) throw new Error("Invalid YAML frontmatter");
  fm[key] = val;
  const serialized = stringifyYaml(fm).trimEnd().replace(/\r?\n/g, newline);
  const header = `---${newline}${serialized}${newline}---`;
  return m
    ? `${header}${content.slice(m[0].length)}`
    : `${header}${newline}${content}`;
}

export async function getFM(
  app: App,
  f: TFile,
): Promise<Record<string, unknown> | null> {
  let content: string;
  try {
    content = await app.vault.read(f);
  } catch {
    return app.metadataCache.getFileCache(f)?.frontmatter || null;
  }
  return parseFM(content);
}

export async function writeFM(
  app: App,
  f: TFile,
  upd: Record<string, string>,
  canWrite: () => boolean = () => true,
): Promise<boolean> {
  try {
    if (!canWrite()) return false;
    let wrote = false;
    await app.vault.process(f, current => {
      if (!canWrite()) return current;
      let updated = current;
      for (const [k, v] of Object.entries(upd)) updated = replaceFMField(updated, k, v);
      wrote = true;
      return updated;
    });
    return wrote;
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
