/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-misused-promises, obsidianmd/ui/sentence-case */
import { Plugin, Notice, TFile, normalizePath } from "obsidian";
import {
  AttachmentHubSettings,
  DEFAULT_SETTINGS,
  isNote,
  isAttach,
  migrateFromAM,
  getOverride,
  normalizePathFormat,
} from "./settings";
import {
  clipImage, ensureFolder,
  pDir, pBase, pJoin, relative, resolve,
  parseFM, replaceFMField, writeFM, stripLink, fmtPath, getAttachmentFolderPath,
  computeAttachPath, computeAttachName, dedup,
} from "./utils";
import { FieldPicker, OverrideModal } from "./modals";
import { AttachmentHubSettingTab } from "./settings-tab";
import { AttachmentProcessor } from "./attachment-processor";
import { FrontmatterSync } from "./frontmatter-sync";
import { IndexManager } from "./index-manager";
import { EventHandlers } from "./event-handlers";

export default class AttachmentHubPlugin extends Plugin {
  settings!: AttachmentHubSettings;

  private _idx = new Map<string, Set<string>>();
  private _noteFields = new Map<string, Map<string, string>>();
  private _createQ: TFile[] = [];
  private _writing = new Set<string>();
  private _modTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  private disposed = false;

  // New managers
  private attachmentProcessor!: AttachmentProcessor;
  private frontmatterSync!: FrontmatterSync;
  private indexManager!: IndexManager;
  private eventHandlers!: EventHandlers;

  async onload(): Promise<void> {
    await this._loadSettings();
    if (this.disposed) return;

    // Initialize managers
    this.indexManager = new IndexManager(this.app, this.settings, this._idx, this._noteFields);
    this.attachmentProcessor = new AttachmentProcessor(this, this.settings, this._writing, this.indexManager);
    this.frontmatterSync = new FrontmatterSync(this, this.indexManager, this._writing);
    this.eventHandlers = new EventHandlers(
      this, 
      this.settings, 
      this.attachmentProcessor, 
      this.frontmatterSync, 
      this.indexManager, 
      this._createQ, 
      this._writing, 
      this._modTimers
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.indexManager.buildIndex();
      this.eventHandlers.registerEvents();
    });

    this.addSettingTab(new AttachmentHubSettingTab(this.app, this));
    this._initCommands();
  }

  onunload(): void {
    this.disposed = true;
    this.eventHandlers?.dispose();
    this.attachmentProcessor?.dispose();
    this.frontmatterSync?.dispose();
    for (const t of Object.values(this._modTimers)) clearTimeout(t);
  }

  // ── Commands ──

  private _initCommands(): void {
    this.addCommand({
      id: "scan-fix-fm",
      name: "扫描并修复所有 frontmatter 路径",
      callback: () => this._scanFixAll(),
    });

    this.addCommand({
      id: "paste-fm",
      name: "粘贴剪贴板图片到 frontmatter 字段",
      checkCallback: (chk: boolean) => {
        const f = this.app.workspace.getActiveFile();
        if (f && isNote(f) && f.extension !== "canvas") {
          if (!chk) this._pasteFM(f).catch(err => console.error("[AttachHub] Paste failed:", err));
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "override-setting",
      name: "覆盖当前文件的附件设置",
      checkCallback: (chk: boolean) => {
        const f = this.app.workspace.getActiveFile();
        if (f && isNote(f)) {
          if (!chk) new OverrideModal(this, f, { ...getOverride(this.settings, f.path) }).open();
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "reset-override",
      name: "重置附件设置覆盖",
      checkCallback: (chk: boolean) => {
        const f = this.app.workspace.getActiveFile();
        if (f && isNote(f)) {
          if (!chk) {
            delete this.settings.overridePath[f.path];
            this.saveSettings().then(() => new Notice("已重置附件设置")).catch(err => console.error("[AttachHub] Save settings failed:", err));
          }
          return true;
        }
        return false;
      },
    });
  }

  // ── Paste to frontmatter ──

  private async _pasteFM(noteFile: TFile): Promise<void> {
    const clip = await clipImage();
    if (this.disposed) return;
    if (!clip) { new Notice("剪贴板中没有图片"); return; }
    const fields = this.settings.trackedFields.filter(field => field.trim());
    if (!fields.length) { new Notice("没有配置追踪字段"); return; }
    const paste = async (field: string) => {
      try {
        if (this.disposed) return;
        const setting = getOverride(this.settings, noteFile.path);
        const folder = computeAttachPath(noteFile, clip.ext, setting, this.settings.dateFormat, getAttachmentFolderPath(this.app));
        const name = await computeAttachName(noteFile, null, setting, this.settings.dateFormat, this.app.vault.adapter);
        if (this.disposed) return;
        await ensureFolder(this.app.vault.adapter, folder);
        const unique = await dedup(`${name || "clipboard"}.${clip.ext}`, folder, this.app.vault.adapter);
        if (this.disposed) return;
        const destination = normalizePath(pJoin(folder, unique));
        await this.app.vault.createBinary(destination, clip.buf);
        if (this.disposed) return;
        const value = fmtPath(relative(pDir(noteFile.path), destination), normalizePathFormat(this.settings.pathFormat));
        this._writing.add(noteFile.path);
        let written: boolean;
        try {
          written = await writeFM(this.app, noteFile, { [field]: value }, () => !this.disposed);
        } finally {
          this._writing.delete(noteFile.path);
        }
        if (this.disposed) return;
        if (!written) throw new Error("属性写入失败，图片已保留");
        new Notice(`图片已保存 → ${field}: ${pBase(destination)}`);
      } catch (error) {
        if (!this.disposed) new Notice(`粘贴失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (fields.length === 1) await paste(fields[0]);
    else new FieldPicker(this.app, fields, paste).open();
  }

  // ── Scan & fix ──

  private async _scanFixAll(): Promise<void> {
    const all = this.app.vault.getFiles();
    const names = new Map<string, TFile[]>();
    for (const file of all) {
      if (!isAttach(file)) continue;
      const key = pBase(file.path);
      const matches = names.get(key) || [];
      matches.push(file);
      names.set(key, matches);
    }
    let fixed = 0, ambiguous = 0;
    for (const file of all.filter(file => isNote(file) && file.extension !== "canvas")) {
      if (this.disposed) return;
      try {
        let changed = false;
        await this.app.vault.process(file, current => {
          if (this.disposed) return current;
          const fm = parseFM(current);
          if (!fm) return current;
          const dir = pDir(file.path);
          for (const field of this.settings.trackedFields) {
            const value = fm[field];
            if (typeof value !== "string" || !value) continue;
            const path = stripLink(value) || value;
            if (/^https?:\/\//.test(path)) continue;
            const resolved = resolve(dir, path);
            if (!resolved || this.app.vault.getAbstractFileByPath(resolved)) continue;
            const matches = names.get(pBase(path)) || [];
            if (matches.length > 1) { ambiguous++; continue; }
            if (matches.length === 1) {
              current = replaceFMField(current, field, fmtPath(relative(dir, matches[0].path), normalizePathFormat(this.settings.pathFormat)));
              changed = true;
            }
          }
          return current;
        });
        if (changed) fixed++;
      } catch (error) {
        console.error("[AttachHub] path repair failed:", file.path, error);
      }
    }
    if (this.disposed) return;
    new Notice(`已修复 ${fixed} 个笔记；跳过 ${ambiguous} 个重名引用`);
    this.indexManager.buildIndex();
  }

  // ── Settings ──

  private async _loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    this.settings.attachPath = { ...DEFAULT_SETTINGS.attachPath, ...(data.attachPath || {}) };
    if (!Array.isArray(this.settings.attachPath.extensionOverride)) this.settings.attachPath.extensionOverride = [];
    if (!Array.isArray(this.settings.trackedFields)) this.settings.trackedFields = ["ogImage"];
    if (!Array.isArray(this.settings.excludePathsArray)) this.settings.excludePathsArray = [];
    if (!Array.isArray(this.settings.originalNameStorage)) this.settings.originalNameStorage = [];
    if (!this.settings.overridePath) this.settings.overridePath = {};
    this.settings.pathFormat = normalizePathFormat(this.settings.pathFormat);

    if (!data._migrated && !data.attachPath) {
      const migrated = await migrateFromAM(this.app.vault.adapter, this.settings, this.app.vault.configDir);
      if (migrated) {
        await this.saveSettings();
        new Notice("已导入 Attachment Management 插件设置");
      }
    }

    if (typeof data.renameFormat === "string") {
      this.settings.attachPath.attachFormat = data.renameFormat;
      this.settings.dateFormat = typeof data.renameDateFormat === "string" ? data.renameDateFormat : this.settings.dateFormat;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    if (this.disposed) return;
    await this.saveData(this.settings);
  }
}
