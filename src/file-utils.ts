import { TFile } from "obsidian";
import { pBase, pDotExt } from "./path-utils";

// Use Web Crypto API for browser compatibility
function createMD5Hash(data: ArrayBuffer): Promise<string> {
  return self.crypto.subtle.digest('MD5', data)
    .then(buffer => {
      const hex = Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      return hex.toUpperCase();
    })
    .catch(() => '');
}

// Cache for folder contents to avoid frequent file system operations
const folderCache = new Map<string, { files: string[]; timestamp: number }>();
const CACHE_DURATION = 30000; // 30 seconds cache

// Cache for MD5 hashes to avoid re-computing for the same file
const md5Cache = new Map<string, { hash: string; timestamp: number }>();

// ══════════════════════════════════════════════════════════════
// MD5
// ══════════════════════════════════════════════════════════════

export async function md5sum(adapter: unknown, file: TFile): Promise<string> {
  const now = Date.now();
  const cacheKey = file.path;
  const cache = md5Cache.get(cacheKey);
  
  // Check if we have a valid cached MD5 hash
  if (cache && now - cache.timestamp < CACHE_DURATION) {
    return cache.hash;
  }
  
  // Calculate MD5 hash and update cache
  try {
    const buf = await (adapter as { readBinary(path: string): Promise<ArrayBuffer> }).readBinary(file.path);
    const hash = await createMD5Hash(buf);
    md5Cache.set(cacheKey, { hash, timestamp: now });
    return hash;
  } catch {
    return "";
  }
}

// ══════════════════════════════════════════════════════════════
// Deduplication
// ══════════════════════════════════════════════════════════════

export async function dedup(name: string, folderPath: string, adapter: unknown): Promise<string> {
  const now = Date.now();
  const cache = folderCache.get(folderPath);
  
  let listed: { files: string[] };
  if (cache && now - cache.timestamp < CACHE_DURATION) {
    // Use cached folder contents
    listed = { files: cache.files };
  } else {
    // Fetch fresh folder contents
    try {
      listed = await (adapter as { list(path: string): Promise<{ files: string[] }> }).list(folderPath);
      // Update cache
      folderCache.set(folderPath, { files: listed.files, timestamp: now });
    } catch {
      return name;
    }
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
