import { normalizePath, TFile } from "obsidian";

// ── Root mode constants ──

export const ROOT_OBS = "obsFolder";
export const ROOT_IN = "inFolderBelow";
export const ROOT_NEXT = "nextToNote";
export const ROOT_LABELS: Record<string, string> = {
  [ROOT_OBS]: "跟随 Obsidian 设置",
  [ROOT_IN]: "Vault 根目录下的子文件夹",
  [ROOT_NEXT]: "笔记同级目录",
};

export const PATH_FMTS: Record<string, string> = {
  plain: "纯路径",
  markdown: "Markdown ![]()",
  wikilink: "Wikilink ![[]]",
};

export type PathFormat = "plain" | "markdown" | "wikilink";

export function normalizePathFormat(value: string | undefined | null): PathFormat {
  const v = (value || "").trim().toLowerCase();
  if (v === "markdown" || v === "markdown ![]()" || v === "![]()") return "markdown";
  if (v === "wikilink" || v === "wikilink ![[]]" || v === "![[]]") return "wikilink";
  return "plain";
}

// ── Type helpers ──

export const NOTE_EXT = new Set(["md", "mdx", "canvas"]);
export const IMG_RE = /^(jpe?g|png|gif|svg|bmp|eps|webp|avif)$/i;
export const VIDEO_RE = /^(mp4|mov|avi|mkv|webm)$/i;
export const HEIC_RE = /^(heic|heif)$/i;
export const PASTED_PREFIX = "Pasted image ";

export function isNote(f: unknown): f is TFile {
  return f instanceof TFile && NOTE_EXT.has(f.extension);
}
export function isAttach(f: unknown): f is TFile {
  return f instanceof TFile && !NOTE_EXT.has(f.extension);
}
export function isImage(ext: string): boolean {
  return IMG_RE.test(ext);
}
export function isVideo(ext: string): boolean {
  return VIDEO_RE.test(ext);
}
export function isHeicExt(ext: string): boolean {
  return HEIC_RE.test(ext);
}
export function isPasted(f: unknown): boolean {
  return f instanceof TFile && f.name.startsWith(PASTED_PREFIX);
}
export function matchExt(ext: string, pat: string): boolean {
  return pat ? new RegExp(pat).test(ext) : false;
}
export function isAttachFile(settings: AttachmentHubSettings, f: unknown): boolean {
  if (!(f instanceof TFile)) return false;
  if (NOTE_EXT.has(f.extension)) return false;
  return !matchExt(f.extension, settings.excludeExtensionPattern);
}

// ── Extension override ──

export interface ExtensionOverride {
  extension: string;
  attachmentRoot: string;
  saveAttE: string;
  attachmentPath: string;
  attachFormat: string;
}

// ── Attach path settings ──

export interface AttachPathSettings {
  attachmentRoot: string;
  saveAttE: string;
  attachmentPath: string;
  attachFormat: string;
  type: string;
  extensionOverride: ExtensionOverride[];
}

// ── Original name entry ──

export interface OriginalNameEntry {
  n: string;
  md5: string;
}

// ── Main settings ──

export interface AttachmentHubSettings {
  attachPath: AttachPathSettings;
  dateFormat: string;

  excludeExtensionPattern: string;
  excludedPaths: string;
  excludePathsArray: string[];
  excludeSubpaths: boolean;
  originalNameStorage: OriginalNameEntry[];
  overridePath: Record<string, AttachPathSettings>;
  disableNotification: boolean;
  trackedFields: string[];
  handleNoteMove: boolean;
  handleAttachmentMove: boolean;
  clearOnDelete: boolean;
  pathFormat: string;
  _migrated?: boolean;
  // Image processing
  convertTo: string;
  quality: number;
  preserveExif: boolean;
  preserveGps: boolean;
  resizeMode: string;
  resizeValue: number;
  // FFmpeg / Video
  ffmpegPath: string;
  videoConvertTo: string;
}

export const DEFAULT_SETTINGS: AttachmentHubSettings = {
  attachPath: {
    attachmentRoot: "",
    saveAttE: ROOT_OBS,
    attachmentPath: "",
    attachFormat: "img-${date}",
    type: "GLOBAL",
    extensionOverride: [],
  },
  dateFormat: "YYYYMMDDHHmmssSSS",

  excludeExtensionPattern: "",
  excludedPaths: "",
  excludePathsArray: [],
  excludeSubpaths: false,
  originalNameStorage: [],
  overridePath: {},
  disableNotification: false,
  trackedFields: ["ogImage"],
  handleNoteMove: true,
  handleAttachmentMove: true,
  clearOnDelete: false,
  pathFormat: "plain",
  convertTo: "disabled",
  quality: 85,
  preserveExif: false,
  preserveGps: false,
  resizeMode: "disabled",
  resizeValue: 1920,
  ffmpegPath: "",
  videoConvertTo: "disabled",
};

// ── Settings helpers ──

export function getExtOverride(ext: string, setting: AttachPathSettings): ExtensionOverride | null {
  if (!setting.extensionOverride) return null;
  for (const eo of setting.extensionOverride) {
    if (eo.extension && new RegExp(`^(${eo.extension})$`, "i").test(ext)) return eo;
  }
  return null;
}

export function effectiveSetting(
  setting: AttachPathSettings,
  attachExt: string | null,
): AttachPathSettings | ExtensionOverride {
  if (!attachExt) return setting;
  return getExtOverride(attachExt, setting) || setting;
}

export function getOverride(settings: AttachmentHubSettings, filePath: string): AttachPathSettings {
  const op = settings.overridePath;
  if (!op || !Object.keys(op).length) return settings.attachPath;
  if (op[filePath] && op[filePath].type === "FILE") return op[filePath];
  const candidates: [string, AttachPathSettings][] = [];
  for (const [p, s] of Object.entries(op)) {
    if (s.type === "FOLDER" && filePath.startsWith(p + "/")) candidates.push([p, s]);
  }
  if (candidates.length) {
    candidates.sort((a, b) => b[0].split("/").length - a[0].split("/").length);
    return candidates[0][1];
  }
  return settings.attachPath;
}

export function updateOverridePath(
  settings: AttachmentHubSettings,
  newPath: string,
  oldPath: string,
): void {
  if (settings.overridePath[oldPath]) {
    settings.overridePath[newPath] = settings.overridePath[oldPath];
    delete settings.overridePath[oldPath];
  }
}

export function isExcluded(dirPath: string, settings: AttachmentHubSettings): boolean {
  for (const ep of settings.excludePathsArray || []) {
    if (!ep) continue;
    if (settings.excludeSubpaths && dirPath.startsWith(ep)) return true;
    if (dirPath === ep) return true;
  }
  return false;
}

export function containsOrigVar(setting: AttachPathSettings, ext: string): boolean {
  const eff = effectiveSetting(setting, ext) as AttachPathSettings;
  return (eff.attachFormat || "").includes("${originalname}");
}

export function saveOrigName(
  settings: AttachmentHubSettings,
  setting: AttachPathSettings,
  ext: string,
  data: OriginalNameEntry,
): void {
  if (!settings.originalNameStorage) settings.originalNameStorage = [];
  if (containsOrigVar(setting, ext)) {
    settings.originalNameStorage = settings.originalNameStorage.filter(n => n.md5 !== data.md5);
    settings.originalNameStorage.push(data);
  }
}

export function loadOrigName(
  settings: AttachmentHubSettings,
  setting: AttachPathSettings,
  ext: string,
  md5: string,
): OriginalNameEntry | undefined {
  if (!containsOrigVar(setting, ext) || !settings.originalNameStorage) return undefined;
  return settings.originalNameStorage.find(d => d.md5 === md5);
}

// ── Settings migration ──

interface AMSettings {
  attachPath?: Partial<AttachPathSettings>;
  dateFormat?: string;
  excludeExtensionPattern?: string;
  excludedPaths?: string;
  excludePathsArray?: string[];
  excludeSubpaths?: boolean;
  originalNameStorage?: OriginalNameEntry[];
  overridePath?: Record<string, AttachPathSettings>;
}

export async function migrateFromAM(
  adapter: { exists: (p: string) => Promise<boolean>; read: (p: string) => Promise<string> },
  settings: AttachmentHubSettings,
  configDir: string,
): Promise<boolean> {
  try {
    const p = normalizePath(`${configDir}/plugins/attachment-management/data.json`);
    if (await adapter.exists(p)) {
      const am = JSON.parse(await adapter.read(p)) as AMSettings;
      if (am.attachPath) settings.attachPath = { ...DEFAULT_SETTINGS.attachPath, ...am.attachPath };
      if (am.dateFormat) settings.dateFormat = am.dateFormat;

      if (am.excludeExtensionPattern) settings.excludeExtensionPattern = am.excludeExtensionPattern;
      if (am.excludedPaths) settings.excludedPaths = am.excludedPaths;
      if (am.excludePathsArray) settings.excludePathsArray = am.excludePathsArray;
      if (am.excludeSubpaths !== undefined) settings.excludeSubpaths = am.excludeSubpaths;
      if (am.originalNameStorage) settings.originalNameStorage = am.originalNameStorage;
      if (am.overridePath) settings.overridePath = am.overridePath;
      settings._migrated = true;
      return true;
    }
  } catch (e: unknown) {
    console.warn("[AttachHub] migrateFromAM failed:", e);
  }
  return false;
}
