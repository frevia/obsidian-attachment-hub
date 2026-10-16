import { TFile } from "obsidian";
import { createHash } from "node:crypto";
import { pDotExt } from "./path-utils";

// ══════════════════════════════════════════════════════════════
// MD5
// ══════════════════════════════════════════════════════════════

export async function md5sum(adapter: unknown, file: TFile): Promise<string> {
  try {
    const buf = await (adapter as { readBinary(path: string): Promise<ArrayBuffer> }).readBinary(file.path);
    return createHash("md5").update(new Uint8Array(buf)).digest("hex").toUpperCase();
  } catch (error) {
    throw new Error(`Unable to calculate MD5 for ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Deduplication
// ══════════════════════════════════════════════════════════════

export async function dedup(
  name: string,
  folderPath: string,
  adapter: unknown,
  ignorePath?: string,
): Promise<string> {
  const fileAdapter = adapter as { exists(path: string, caseSensitive?: boolean): Promise<boolean> };
  const targetPath = (candidate: string) => folderPath ? `${folderPath.replace(/\/$/, "")}/${candidate}` : candidate;
  const available = async (candidate: string): Promise<boolean> => {
    const path = targetPath(candidate);
    return path === ignorePath || !(await fileAdapter.exists(path, true));
  };
  if (await available(name)) return name;
  const dotExt = pDotExt(name);
  const stem = name.slice(0, name.length - dotExt.length);
  for (let suffix = 1; ; suffix++) {
    const candidate = `${stem}-${suffix}${dotExt}`;
    if (await available(candidate)) return candidate;
  }
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
  "image/heic": "heic",
  "image/heif": "heif",
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
  } catch {
    // Clipboard access failed
  }
  return null;
}

export async function ensureFolder(adapter: unknown, p: string): Promise<void> {
  if (p && !(await (adapter as { exists(path: string, caseSensitive?: boolean): Promise<boolean> }).exists(p, true))) {
    await (adapter as { mkdir(path: string): Promise<void> }).mkdir(p);
  }
}

export async function isEmptyFolder(adapter: unknown, p: string): Promise<boolean> {
  if (!p) return false;
  try {
    const l = await (adapter as { list(path: string): Promise<{ files: string[]; folders: string[] }> }).list(p);
    return !l.files.length && !l.folders.length;
  } catch {
    return false;
  }
}
