import { TFile, normalizePath } from "obsidian";
import {
  AttachPathSettings,
  effectiveSetting,
  ROOT_IN,
  ROOT_NEXT,
} from "./settings";

// Re-export path utilities
export {
  pDir,
  pBase,
  pExt,
  pStem,
  pDotExt,
  pJoin,
  resolve,
  relative,
} from "./path-utils";

// Re-export frontmatter utilities
export {
  parseFM,
  fmSection,
  replaceFMField,
  getFM,
  writeFM,
  stripLink,
  fmtPath,
  extractResolvedPaths,
} from "./frontmatter-utils";

// Re-export file utilities
export {
  md5sum,
  dedup,
  clipImage,
  ensureFolder,
  isEmptyFolder,
} from "./file-utils";

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
  const d = (window as { moment?: (date?: unknown) => { format: (fmt: string) => string } }).moment
    ? (window as { moment?: (date?: unknown) => { format: (fmt: string) => string } }).moment!().format(ctx.dateFormat || "YYYYMMDDHHmmssSSS")
    : Date.now().toString();
  return template
    .replace(/\$\{date\}/g, d)
    .replace(/\$\{notename\}/g, ctx.noteName || "")
    .replace(/\$\{notepath\}/g, ctx.noteDir || "")
    .replace(/\$\{parent\}/g, ctx.parentName || "")
    .replace(/\$\{originalname\}/g, ctx.origName || "")
    .replace(/\$\{md5\}/g, ctx.md5 || "");
}

export function getRootPath(noteDir: string, setting: { saveAttE: string; attachmentRoot?: string }, obsFolder: string): string {
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
  adapter: unknown,
  fallbackName?: string,
): Promise<string> {
  const eff = effectiveSetting(setting, attachFile ? pExt(attachFile.path) : null);
  const fmt = eff.attachFormat || "img-${date}";
  const noteName = pStem(noteFile.path);
  const md5Val = attachFile && fmt.includes("${md5}") ? await md5sum(adapter, attachFile) : "";

  if (fmt.includes("${originalname}")) {
    const origName = attachFile ? pStem(attachFile.path) : "";
    if (!origName && fallbackName) return fallbackName;
    return resolveVars(fmt, { dateFormat, noteName, noteDir: "", parentName: "", origName, md5: md5Val });
  }
  return resolveVars(fmt, { dateFormat, noteName, noteDir: "", parentName: "", origName: "", md5: md5Val });
}

export function getAttachmentFolderPath(app: unknown): string {
  if (typeof app !== "object" || app === null) return "";
  if ("getConfig" in app && typeof (app as { getConfig?: unknown }).getConfig === "function") {
    const value = (app as { getConfig: (key: string) => unknown }).getConfig("attachmentFolderPath");
    if (typeof value === "string") return value;
  }
  if ("vault" in app) {
    const vault = (app as { vault?: unknown }).vault;
    if (
      typeof vault === "object" &&
      vault !== null &&
      "getConfig" in vault &&
      typeof (vault as { getConfig?: unknown }).getConfig === "function"
    ) {
      const value = (vault as { getConfig: (key: string) => unknown }).getConfig("attachmentFolderPath");
      if (typeof value === "string") return value;
    }
  }
  return "";
}

// Import needed for the functions above
import { pDir, pBase, pExt, pStem, pJoin } from "./path-utils";
import { md5sum } from "./file-utils";
