/* eslint-disable @typescript-eslint/no-floating-promises, no-empty */
import { Plugin, TFile, TFolder, normalizePath } from "obsidian";
import {
  AttachmentHubSettings,
  AttachPathSettings,
  isNote,
  isAttach,
  updateOverridePath,
  isExcluded,
  NOTE_EXT,
  getOverride,
} from "./settings";
import { AttachmentProcessor } from "./attachment-processor";
import { FrontmatterSync } from "./frontmatter-sync";
import { IndexManager } from "./index-manager";
import { OverrideModal } from "./modals";
import { debounce } from "./utils";

interface OverridePlugin extends Plugin {
  settings: AttachmentHubSettings;
  saveSettings(): Promise<void>;
}

interface AdapterWithList {
  list: (path: string) => Promise<{ files: unknown[]; folders: unknown[] }>;
}

interface VarCtx {
  dateFormat?: string;
  noteName?: string;
  noteDir?: string;
  parentName?: string;
  origName?: string;
  md5?: string;
}

function getAttachmentFolderPath(app: unknown): string {
  if (
    typeof app === "object" &&
    app !== null &&
    "getConfig" in app &&
    typeof (app as { getConfig?: unknown }).getConfig === "function"
  ) {
    const value = (app as { getConfig: (key: string) => unknown }).getConfig("attachmentFolderPath");
    return typeof value === "string" ? value : "";
  }
  return "";
}

export class EventHandlers {
  private plugin: OverridePlugin;
  private settings: AttachmentHubSettings;
  private attachmentProcessor: AttachmentProcessor;
  private frontmatterSync: FrontmatterSync;
  private indexManager: IndexManager;
  private _createQ: TFile[];
  private _writing: Set<string>;
  private _modTimers: Record<string, ReturnType<typeof setTimeout>>;
  private _debouncedPasteDetect: (file: TFile) => void;

  constructor(
    plugin: OverridePlugin,
    settings: AttachmentHubSettings,
    attachmentProcessor: AttachmentProcessor,
    frontmatterSync: FrontmatterSync,
    indexManager: IndexManager,
    createQ: TFile[],
    writing: Set<string>,
    modTimers: Record<string, ReturnType<typeof setTimeout>>
  ) {
    this.plugin = plugin;
    this.settings = settings;
    this.attachmentProcessor = attachmentProcessor;
    this.frontmatterSync = frontmatterSync;
    this.indexManager = indexManager;
    this._createQ = createQ;
    this._writing = writing;
    this._modTimers = modTimers;
    
    // Create debounced version of paste detection
    this._debouncedPasteDetect = debounce((file: TFile) => {
      this._handlePasteDetect(file);
    }, 300);
  }

  registerEvents(): void {
    // File create event
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || NOTE_EXT.has(file.extension)) return;
        if (Date.now() - file.stat.ctime > 1000) return;
        if (this.matchExt(file.extension, this.settings.excludeExtensionPattern)) return;
        this._createQ.push(file);
      }),
    );

    // File modify event
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || !isNote(file) || this._writing.has(file.path)) return;
        if (this._createQ.length > 0) this._debouncedPasteDetect(file);
        if (file.extension === "mdx") {
          if (this._modTimers[file.path]) clearTimeout(this._modTimers[file.path]);
          this._modTimers[file.path] = setTimeout(() => {
            delete this._modTimers[file.path];
            this.frontmatterSync.onMdxModify(file);
          }, 600);
        }
      }),
    );

    // Metadata cache changed event
    this.plugin.registerEvent(
      this.plugin.app.metadataCache.on("changed", (file) => {
        if (!(file instanceof TFile) || !isNote(file) || this._writing.has(file.path)) return;
        if (file.extension !== "md") return;
        // During paste/import bursts, defer FM normalization to avoid intermediate
        // link rewrites before attachment rename/conversion settles.
        if (this._createQ.length > 0) {
          const timerKey = `fm:${file.path}`;
          if (this._modTimers[timerKey]) clearTimeout(this._modTimers[timerKey]);
          this._modTimers[timerKey] = setTimeout(() => {
            delete this._modTimers[timerKey];
            if (!this._writing.has(file.path)) void this.frontmatterSync.onFMChange(file);
          }, 900);
          return;
        }
        void this.frontmatterSync.onFMChange(file);
      }),
    );

    // File rename event
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", async (file, oldPath) => {
        const ovr = this.settings.overridePath[oldPath];
        if (ovr) {
          updateOverridePath(this.settings, file.path, oldPath);
          await this.plugin.saveSettings();
        }
        if (file instanceof TFile && isNote(file)) {
          this.indexManager.removeNoteFromIndex(oldPath);
          if (file.parent && isExcluded(file.parent.path, this.settings)) return;
          if (this.settings.handleNoteMove) await this.frontmatterSync.handleNoteMove(file, oldPath);
        } else if (file instanceof TFile && isAttach(file) && this.settings.handleAttachmentMove) {
          await this.frontmatterSync.handleAttachRename(file, oldPath);
        }
      }),
    );

    // File delete event
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", async (file) => {
        if (isNote(file)) {
          this.indexManager.removeNoteFromIndex(file.path);
          if (this.settings.overridePath[file.path]) {
            delete this.settings.overridePath[file.path];
            await this.plugin.saveSettings();
          }
          this._cleanOldAttachFolder(file.path);
          return;
        }
        if (isAttach(file) && this.settings.clearOnDelete) this.frontmatterSync.onAttachDelete(file);
      }),
    );

    // File menu event
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-menu", (menu, file) => {
        if ((file instanceof TFile && file.parent && isExcluded(file.parent.path, this.settings)) || isAttach(file))
          return;
        menu.addItem(item => {
          item.setTitle("Override attachment setting").setIcon("image-plus").onClick(() => {
            const s = { ...this.getOverride(this.settings, file.path) };
            new OverrideModal(this.plugin, file as TFile | TFolder, s).open();
          });
        });
      }),
    );
  }

  private async _handlePasteDetect(noteFile: TFile): Promise<void> {
    const f = this._createQ[0];
    if (!f) return;
    try {
      if (!(await this.plugin.app.vault.adapter.exists(f.path))) {
        this._createQ.shift();
        return;
      }
      const content = await this.plugin.app.vault.adapter.read(noteFile.path);
      const link = this.plugin.app.fileManager.generateMarkdownLink(f, noteFile.path);
      const relPath = this.relative(this.pDir(noteFile.path), f.path);
      const found =
        content.includes(link) ||
        content.includes(f.name) ||
        content.includes(relPath) ||
        (noteFile.extension === "canvas" && content.includes(f.path));
      if (found) {
        this._createQ.shift();
        await this.attachmentProcessor.processNewAttach(f, noteFile);
      }
    } catch {}
  }

  private async _cleanOldAttachFolder(notePath: string): Promise<void> {
    const setting = this.getOverride(this.settings, notePath);
    const obsFolder = getAttachmentFolderPath(this.plugin.app);
    const noteDir = this.pDir(notePath);
    const sub = this.resolveVars(setting.attachmentPath || "", {
      dateFormat: this.settings.dateFormat,
      noteName: this.pStem(notePath),
      noteDir,
      parentName: this.pBase(noteDir),
    });
    const root = this.getRootPath(noteDir, setting, obsFolder);
    const old = this.normalizePath(this.pJoin(root, sub));
    if (old && (await this.isEmptyFolder(this.plugin.app.vault.adapter, old))) {
      try { await this.plugin.app.vault.adapter.rmdir(old, true); } catch {}
    }
  }

  // Helper methods
  private isNote(f: unknown): f is TFile {
    return isNote(f);
  }

  private isAttach(f: unknown): f is TFile {
    return isAttach(f);
  }

  private isExcluded(dirPath: string, settings: AttachmentHubSettings): boolean {
    return isExcluded(dirPath, settings);
  }

  private matchExt(ext: string, pat: string): boolean {
    return pat ? new RegExp(pat).test(ext) : false;
  }

  private getOverride(settings: AttachmentHubSettings, filePath: string): AttachPathSettings {
    return getOverride(settings, filePath);
  }

  private pDir(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.substring(0, i);
  }

  private pBase(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.substring(i + 1);
  }

  private pStem(p: string): string {
    const b = this.pBase(p), i = b.lastIndexOf(".");
    return i < 0 ? b : b.substring(0, i);
  }

  private pJoin(...parts: string[]): string {
    const s: string[] = [];
    for (const p of parts) {
      for (const seg of p.split("/")) {
        if (seg === "..") s.pop();
        else if (seg && seg !== ".") s.push(seg);
      }
    }
    return s.join("/");
  }

  private normalizePath(p: string): string {
    return normalizePath(p);
  }

  private relative(fromDir: string, toPath: string): string {
    const f = fromDir ? fromDir.split("/") : [];
    const t = toPath.split("/");
    let c = 0;
    while (c < f.length && c < t.length && f[c] === t[c]) c++;
    const p: string[] = [];
    for (let i = 0; i < f.length - c; i++) p.push("..");
    p.push(...t.slice(c));
    return p.join("/");
  }

  private resolveVars(template: string, ctx: VarCtx): string {
    const w = window as Window & { moment?: () => { format: (fmt: string) => string } };
    const d = w.moment
      ? w.moment().format(ctx.dateFormat || "YYYYMMDDHHmmssSSS")
      : Date.now().toString();
    return template
      .replace(/\$\{date\}/g, d)
      .replace(/\$\{notename\}/g, ctx.noteName || "")
      .replace(/\$\{notepath\}/g, ctx.noteDir || "")
      .replace(/\$\{parent\}/g, ctx.parentName || "")
      .replace(/\$\{originalname\}/g, ctx.origName || "")
      .replace(/\$\{md5\}/g, ctx.md5 || "");
  }

  private getRootPath(noteDir: string, setting: AttachPathSettings, obsFolder: string): string {
    switch (setting.saveAttE) {
      case "inFolderBelow":
        return this.normalizePath(setting.attachmentRoot || "");
      case "nextToNote":
        return this.normalizePath(this.pJoin(noteDir, (setting.attachmentRoot || "").replace(/^\.\//, "")));
      default:
        if (!obsFolder || obsFolder === "/") return obsFolder === "/" ? "" : "";
        if (obsFolder === "./") return noteDir;
        if (obsFolder.startsWith("./"))
          return this.normalizePath(this.pJoin(noteDir, obsFolder.replace(/^\.\//, "")));
        return this.normalizePath(obsFolder);
    }
  }

  private async isEmptyFolder(adapter: AdapterWithList, p: string): Promise<boolean> {
    if (!p) return false;
    try {
      const l = await adapter.list(p);
      return !l.files.length && !l.folders.length;
    } catch {
      return false;
    }
  }
}
