/* eslint-disable @typescript-eslint/no-floating-promises, no-empty */
import { Plugin, TFile, TFolder } from "obsidian";
import {
  AttachmentHubSettings,
  isNote,
  isAttach,
  updateOverridePath,
  isExcluded,
  NOTE_EXT,
  getOverride,
  matchExt,
} from "./settings";
import { AttachmentProcessor } from "./attachment-processor";
import { FrontmatterSync } from "./frontmatter-sync";
import { IndexManager } from "./index-manager";
import { OverrideModal } from "./modals";
import {
  getAttachmentFolderPath,
  getRootPath,
  isEmptyFolder,
  pBase,
  pDir,
  pJoin,
  pStem,
  relative,
  resolveVars,
} from "./utils";

interface OverridePlugin extends Plugin {
  settings: AttachmentHubSettings;
  saveSettings(): Promise<void>;
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
  private _pendingPasteNotes = new Set<TFile>();
  private _pasteTimer: ReturnType<typeof setTimeout> | null = null;
  private _pasteTask: Promise<void> = Promise.resolve();
  private _disposed = false;

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
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._pasteTimer !== null) clearTimeout(this._pasteTimer);
    this._pasteTimer = null;
    this._pendingPasteNotes.clear();
    for (const timer of Object.values(this._modTimers)) clearTimeout(timer);
    for (const key of Object.keys(this._modTimers)) delete this._modTimers[key];
  }

  private _schedulePasteDetect(file: TFile): void {
    if (this._disposed) return;
    this._pendingPasteNotes.add(file);
    if (this._pasteTimer !== null) clearTimeout(this._pasteTimer);
    this._pasteTimer = setTimeout(() => {
      this._pasteTimer = null;
      if (this._disposed) return;
      const notes = [...this._pendingPasteNotes];
      this._pendingPasteNotes.clear();
      for (const note of notes) void this._handlePasteDetect(note);
    }, 300);
  }

  registerEvents(): void {
    // File create event
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => {
        if (this._disposed) return;
        if (!(file instanceof TFile) || NOTE_EXT.has(file.extension)) return;
        if (this.attachmentProcessor.consumeCreated(file.path)) return;
        if (Date.now() - file.stat.ctime > 1000) return;
        if (matchExt(file.extension, this.settings.excludeExtensionPattern)) return;
        this._createQ.push(file);
      }),
    );

    // File modify event
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => {
        if (this._disposed) return;
        if (!(file instanceof TFile) || !isNote(file)) return;
        if (this._createQ.length > 0) this._schedulePasteDetect(file);
        if (this._writing.has(file.path)) return;
        if (file.extension === "mdx") {
          if (this._modTimers[file.path]) clearTimeout(this._modTimers[file.path]);
          this._modTimers[file.path] = setTimeout(() => {
            delete this._modTimers[file.path];
            if (this._disposed) return;
            this.frontmatterSync.onMdxModify(file);
          }, 600);
        }
      }),
    );

    // Metadata cache changed event
    this.plugin.registerEvent(
      this.plugin.app.metadataCache.on("changed", (file) => {
        if (this._disposed) return;
        if (!(file instanceof TFile) || !isNote(file) || this._writing.has(file.path)) return;
        if (file.extension !== "md") return;
        // During paste/import bursts, defer FM normalization to avoid intermediate
        // link rewrites before attachment rename/conversion settles.
        if (this._createQ.length > 0) {
          const timerKey = `fm:${file.path}`;
          if (this._modTimers[timerKey]) clearTimeout(this._modTimers[timerKey]);
          this._modTimers[timerKey] = setTimeout(() => {
            delete this._modTimers[timerKey];
            if (this._disposed) return;
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
        if (this._disposed) return;
        const ovr = this.settings.overridePath[oldPath];
        if (ovr) {
          updateOverridePath(this.settings, file.path, oldPath);
          await this.plugin.saveSettings();
          if (this._disposed) return;
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
        if (this._disposed) return;
        if (isNote(file)) {
          this.indexManager.removeNoteFromIndex(file.path);
          if (this.settings.overridePath[file.path]) {
            delete this.settings.overridePath[file.path];
            await this.plugin.saveSettings();
            if (this._disposed) return;
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
        if (this._disposed) return;
        if ((file instanceof TFile && file.parent && isExcluded(file.parent.path, this.settings)) || isAttach(file))
          return;
        menu.addItem(item => {
          item.setTitle("Override attachment setting").setIcon("image-plus").onClick(() => {
            if (this._disposed) return;
            const s = { ...getOverride(this.settings, file.path) };
            new OverrideModal(this.plugin, file as TFile | TFolder, s).open();
          });
        });
      }),
    );
  }

  private _handlePasteDetect(noteFile: TFile): Promise<void> {
    // Link updates must finish before another paste detection processes the same note.
    this._pasteTask = this._pasteTask.then(async () => {
      if (this._disposed) return;
      for (const f of [...this._createQ]) {
        if (this._disposed) return;
        const index = this._createQ.indexOf(f);
        if (index < 0) continue;
        try {
          const exists = await this.plugin.app.vault.adapter.exists(f.path);
          if (this._disposed) return;
          if (!exists) {
            this._createQ.splice(index, 1);
            continue;
          }
          const content = await this.plugin.app.vault.adapter.read(noteFile.path);
          if (this._disposed) return;
          const link = this.plugin.app.fileManager.generateMarkdownLink(f, noteFile.path);
          const relPath = relative(pDir(noteFile.path), f.path);
          const found =
            content.includes(link) ||
            content.includes(f.name) ||
            content.includes(relPath) ||
            (noteFile.extension === "canvas" && content.includes(f.path));
          if (!found) continue;
          this._createQ.splice(index, 1);
          await this.attachmentProcessor.processNewAttach(f, noteFile);
          if (this._disposed) return;
        } catch (e) {
          if (this._disposed) return;
          console.error("[AttachHub] attachment processing failed:", f.path, e);
        }
      }
    });
    return this._pasteTask;
  }

  private async _cleanOldAttachFolder(notePath: string): Promise<void> {
    if (this._disposed) return;
    const setting = getOverride(this.settings, notePath);
    const obsFolder = getAttachmentFolderPath(this.plugin.app);
    const noteDir = pDir(notePath);
    const sub = resolveVars(setting.attachmentPath || "", {
      dateFormat: this.settings.dateFormat,
      noteName: pStem(notePath),
      noteDir,
      parentName: pBase(noteDir),
    });
    const root = getRootPath(noteDir, setting, obsFolder);
    const old = pJoin(root, sub);
    if (old && (await isEmptyFolder(this.plugin.app.vault.adapter, old)) && !this._disposed) {
      try { await this.plugin.app.vault.adapter.rmdir(old, true); } catch {}
    }
  }
}
