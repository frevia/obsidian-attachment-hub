import { TFile, normalizePath, Notice } from "obsidian";
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
  yamlSafe,
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
// Error handling and logging utility
// ══════════════════════════════════════════════════════════════

export class ErrorHandler {
  private static instance: ErrorHandler;
  private logs: Array<{ timestamp: number; level: string; message: string; error?: Error }> = [];
  private maxLogs: number = 100;

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  log(level: string, message: string, error?: Error): void {
    const timestamp = Date.now();
    this.logs.push({ timestamp, level, message, error });
    
    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    
    // Console output for debugging
    const logMessage = `[${new Date(timestamp).toISOString()}] [${level}] ${message}`;
    if (error) {
      console.error(logMessage, error);
    } else {
      console.debug(logMessage);
    }
  }

  info(message: string): void {
    this.log('INFO', message);
  }

  warn(message: string, error?: Error): void {
    this.log('WARN', message, error);
  }

  error(message: string, error?: Error): void {
    this.log('ERROR', message, error);
  }

  getLogs(): Array<{ timestamp: number; level: string; message: string; error?: Error }> {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }
}

// Wrapper for async operations with error handling
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  errorMessage: string,
  errorHandler: ErrorHandler = ErrorHandler.getInstance()
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    errorHandler.error(errorMessage, error instanceof Error ? error : new Error(String(error)));
    return undefined;
  }
}

// User-friendly error notification
export function showUserError(message: string, duration: number = 5000): void {
  new Notice(`❌ ${message}`, duration);
}

// User-friendly success notification
export function showUserSuccess(message: string, duration: number = 3000): void {
  new Notice(`✅ ${message}`, duration);
}

// User-friendly warning notification
export function showUserWarning(message: string, duration: number = 4000): void {
  new Notice(`⚠️ ${message}`, duration);
}

// User-friendly info notification
export function showUserInfo(message: string, duration: number = 3000): void {
  new Notice(`ℹ️ ${message}`, duration);
}

// Debounce utility to prevent rapid repeated calls
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      func(...args);
      timeout = null;
    }, wait);
  };
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
  const md5Val = attachFile ? await md5sum(adapter, attachFile) : "";

  if (fmt.includes("${originalname}")) {
    const origName = attachFile ? pStem(attachFile.path) : "";
    if (!origName && fallbackName) return fallbackName;
    return resolveVars(fmt, { dateFormat, noteName, noteDir: "", parentName: "", origName, md5: md5Val });
  }
  return resolveVars(fmt, { dateFormat, noteName, noteDir: "", parentName: "", origName: "", md5: md5Val });
}

// Import needed for the functions above
import { pDir, pBase, pExt, pStem, pJoin } from "./path-utils";
import { md5sum } from "./file-utils";
