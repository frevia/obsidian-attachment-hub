import { normalizePath } from "obsidian";

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
