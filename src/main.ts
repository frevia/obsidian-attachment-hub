import { Plugin, Notice, TFile, TFolder, normalizePath } from "obsidian";
import {
  AttachmentHubSettings,
  DEFAULT_SETTINGS,
  NOTE_EXT,
  isNote,
  isAttach,
  isImage,
  isVideo,
  isHeicExt,
  isPasted,
  matchExt,
  getExtOverride,
  getOverride,
  updateOverridePath,
  isExcluded,
  saveOrigName,
  effectiveSetting,
  migrateFromAM,
} from "./settings";
import { convertVideoFile, isAnimatedHeic, VideoTarget } from "./ffmpeg-handler";
import { convertImage, ImageFormat, ResizeOpts } from "./image-processor";
import { decodeHeic } from "./heic-handler";
import {
  pDir, pBase, pExt, pStem, pJoin,
  resolve, relative,
  md5sum,
  resolveVars,
  getRootPath,
  computeAttachPath,
  computeAttachName,
  dedup,
  parseFM, fmSection, replaceFMField,
  getFM, writeFM,
  stripLink, fmtPath,
  clipImage, ensureFolder, isEmptyFolder,
  extractResolvedPaths,
} from "./utils";
import { FieldPicker, OverrideModal } from "./modals";
import { AttachmentHubSettingTab } from "./settings-tab";

export default class AttachmentHubPlugin extends Plugin {
  settings!: AttachmentHubSettings;

  private _idx = new Map<string, Set<string>>();
  private _noteFields = new Map<string, Map<string, string>>();
  private _createQ: TFile[] = [];
  private _writing = new Set<string>();
  private _modTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  private _mdxHash = new Map<string, string>();
  private _renameT?: ReturnType<typeof setTimeout>;

  async onload(): Promise<void> {
    await this._loadSettings();

    this.app.workspace.onLayoutReady(() => {
      this._buildIndex();

      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!(file instanceof TFile) || NOTE_EXT.has(file.extension)) return;
          if (Date.now() - file.stat.ctime > 1000) return;
          if (matchExt(file.extension, this.settings.excludeExtensionPattern)) return;
          this._createQ.push(file);
        }),
      );

      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (!(file instanceof TFile) || !isNote(file) || this._writing.has(file.path)) return;
          if (this._createQ.length > 0) this._handlePasteDetect(file);
          if (file.extension === "mdx") {
            if (this._modTimers[file.path]) clearTimeout(this._modTimers[file.path]);
            this._modTimers[file.path] = setTimeout(() => {
              delete this._modTimers[file.path];
              this._onMdxModify(file);
            }, 600);
          }
        }),
      );

      this.registerEvent(
        this.app.metadataCache.on("changed", (file) => {
          if (!(file instanceof TFile) || !isNote(file) || this._writing.has(file.path)) return;
          if (file.extension === "md") this._onFMChange(file);
        }),
      );

      this.registerEvent(
        this.app.vault.on("rename", async (file, oldPath) => {
          const ovr = this.settings.overridePath[oldPath];
          if (ovr) {
            updateOverridePath(this.settings, file.path, oldPath);
            await this.saveSettings();
          }
          if (file instanceof TFile && isNote(file)) {
            this._removeNoteFromIndex(oldPath);
            if (file.parent && isExcluded(file.parent.path, this.settings)) return;
            if (this.settings.handleNoteMove) await this._handleNoteMove(file, oldPath);
          } else if (file instanceof TFile && isAttach(file) && this.settings.handleAttachmentMove) {
            await this._handleAttachRename(file, oldPath);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on("delete", async (file) => {
          if (isNote(file)) {
            this._removeNoteFromIndex(file.path);
            if (this.settings.overridePath[file.path]) {
              delete this.settings.overridePath[file.path];
              await this.saveSettings();
            }
            this._cleanOldAttachFolder(file.path);
            return;
          }
          if (isAttach(file) && this.settings.clearOnDelete) this._onAttachDelete(file as TFile);
        }),
      );

      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          if ((file instanceof TFile && file.parent && isExcluded(file.parent.path, this.settings)) || isAttach(file))
            return;
          menu.addItem(item => {
            item.setTitle("Override attachment setting").setIcon("image-plus").onClick(() => {
              const s = { ...getOverride(this.settings, file.path) };
              new OverrideModal(this, file as TFile | TFolder, s).open();
            });
          });
        }),
      );
    });

    this.addSettingTab(new AttachmentHubSettingTab(this.app, this));
    this._initCommands();
  }

  onunload(): void {
    if (this._renameT) clearTimeout(this._renameT);
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
        if (f && isNote(f)) {
          if (!chk) this._pasteFM(f);
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
            this.saveSettings().then(() => new Notice("已重置附件设置"));
          }
          return true;
        }
        return false;
      },
    });
  }

  // ── Index management ──

  private _buildIndex(): void {
    this._idx.clear();
    this._noteFields.clear();
    for (const f of this.app.vault.getFiles()) {
      if (!isNote(f)) continue;
      const c = this.app.metadataCache.getFileCache(f);
      const fm = c?.frontmatter;
      if (!fm) continue;
      const map = extractResolvedPaths(fm, this.settings.trackedFields, pDir(f.path));
      if (map.size) {
        this._noteFields.set(f.path, map);
        for (const aPath of map.values()) {
          let s = this._idx.get(aPath);
          if (!s) { s = new Set(); this._idx.set(aPath, s); }
          s.add(f.path);
        }
      }
    }
  }

  private _updateNoteIndex(notePath: string, newMap: Map<string, string> | null): void {
    const old = this._noteFields.get(notePath);
    if (old) {
      for (const aPath of old.values()) {
        const s = this._idx.get(aPath);
        if (s) { s.delete(notePath); if (!s.size) this._idx.delete(aPath); }
      }
    }
    if (newMap && newMap.size) {
      this._noteFields.set(notePath, newMap);
      for (const aPath of newMap.values()) {
        let s = this._idx.get(aPath);
        if (!s) { s = new Set(); this._idx.set(aPath, s); }
        s.add(notePath);
      }
    } else {
      this._noteFields.delete(notePath);
    }
  }

  private _removeNoteFromIndex(p: string): void {
    this._updateNoteIndex(p, null);
  }

  private _getNotesFor(ap: string): Set<string> {
    return this._idx.get(normalizePath(ap)) || new Set();
  }

  // ── Paste detection ──

  private async _handlePasteDetect(noteFile: TFile): Promise<void> {
    const f = this._createQ[0];
    if (!f) return;
    try {
      if (!(await this.app.vault.adapter.exists(f.path))) {
        this._createQ.shift();
        return;
      }
      const content = await this.app.vault.adapter.read(noteFile.path);
      const link = this.app.fileManager.generateMarkdownLink(f, noteFile.path);
      const relPath = relative(pDir(noteFile.path), f.path);
      const found =
        content.includes(link) ||
        content.includes(f.name) ||
        content.includes(relPath) ||
        (noteFile.extension === "canvas" && content.includes(f.path));
      if (found) {
        this._createQ.shift();
        await this._processNewAttach(f, noteFile);
      }
    } catch (_) {}
  }

  private async _processNewAttach(attach: TFile, source: TFile): Promise<void> {
    if (source.parent && isExcluded(source.parent.path, this.settings)) return;
    const setting = getOverride(this.settings, source.path);
    const eo = getExtOverride(attach.extension, setting);
    if (!eo && !isImage(attach.extension) && !isVideo(attach.extension) && !isHeicExt(attach.extension) && !isPasted(attach)) return;

    // ── Conversion: only modify binary data, no rename yet ──
    let convertedExt: string | null = null;
    const shouldTryFFmpeg = this.settings.ffmpegPath && this.settings.videoConvertTo !== "disabled";
    const shouldConvertImage = this.settings.convertTo !== "disabled";

    if (isVideo(attach.extension)) {
      if (shouldTryFFmpeg) {
        const result = await this._convertVideoData(attach);
        if (result) {
          await this.app.vault.modifyBinary(attach, result.data);
          convertedExt = result.ext;
        }
      }
    } else if (isHeicExt(attach.extension)) {
      const animated = shouldTryFFmpeg && (await this._isHeicAnimated(attach));
      if (animated) {
        const result = await this._convertVideoData(attach);
        if (result) {
          await this.app.vault.modifyBinary(attach, result.data);
          convertedExt = result.ext;
        }
      } else if (shouldConvertImage) {
        const result = await this._convertImageData(attach);
        if (result) {
          await this.app.vault.modifyBinary(attach, result.data);
          convertedExt = result.ext;
        }
      }
    } else if (shouldConvertImage && isImage(attach.extension)) {
      const result = await this._convertImageData(attach);
      if (result) {
        await this.app.vault.modifyBinary(attach, result.data);
        convertedExt = result.ext;
      }
    }

    // Use new extension if converted, otherwise keep original
    const finalExt = convertedExt || attach.extension;

    const obsFolder = (this.app.vault as any).getConfig("attachmentFolderPath") || "";
    const attachPath = computeAttachPath(source, finalExt, setting, this.settings.dateFormat, obsFolder);
    let attachName = await computeAttachName(
      source, attach, setting, this.settings.dateFormat, this.app.vault.adapter,
    );
    attachName += "." + finalExt;

    await ensureFolder(this.app.vault.adapter, attachPath);
    const dedupName = await dedup(attachName, attachPath, this.app.vault.adapter);
    const dst = normalizePath(pJoin(attachPath, dedupName));

    const oldPath = attach.path;
    const origBasename = pStem(attach.path);
    try {
      await this.app.fileManager.renameFile(attach, dst);
    } catch (e) {
      console.error("[AttachHub] rename failed:", e);
      return;
    }

    // fileManager.renameFile relies on resolvedLinks which may not be up-to-date
    // after a fresh paste. Manually patch the source note to ensure the link is correct.
    await this._patchSourceNoteLink(source, oldPath, dst);

    const msg = convertedExt
      ? `已转换并重命名 ${pBase(oldPath)} → ${dedupName}`
      : `已重命名 ${pBase(oldPath)} → ${dedupName}`;
    if (!this.settings.disableNotification) new Notice(msg);

    const renamedFile = this.app.vault.getAbstractFileByPath(dst);
    if (renamedFile instanceof TFile) {
      const md5Val = await md5sum(this.app.vault.adapter, renamedFile);
      saveOrigName(this.settings, setting, pExt(dst), { n: origBasename, md5: md5Val });
      await this.saveSettings();
    }

    await this._updateFMAfterRename(source, oldPath, dst);
  }

  /**
   * Convert video data via system FFmpeg. Returns raw result, does NOT touch the vault file.
   */
  private async _convertVideoData(attach: TFile): Promise<{ data: ArrayBuffer; ext: string } | null> {
    try {
      const basePath = (this.app.vault.adapter as any).basePath as string;
      if (!basePath) return null;
      const absPath = require("path").join(basePath, attach.path);
      return await convertVideoFile(absPath, attach.extension, {
        ffmpegPath: this.settings.ffmpegPath,
        target: this.settings.videoConvertTo as VideoTarget,
        quality: this.settings.quality,
        resizeValue: this.settings.resizeMode !== "disabled" ? this.settings.resizeValue : 0,
      });
    } catch (e: any) {
      console.error("[AttachHub] Video conversion error:", e);
      return null;
    }
  }

  /**
   * Convert image data via Canvas API (HEIC decoded first).
   * For HEIC: native decode → heic2any → FFmpeg fallback.
   * Returns raw result, does NOT touch the vault file.
   */
  private async _convertImageData(attach: TFile): Promise<{ data: ArrayBuffer; ext: string } | null> {
    const target = this.settings.convertTo as ImageFormat;
    if (target === "disabled") return null;
    const ext = attach.extension.toLowerCase();
    if (ext === target || (target === "jpg" && /^jpe?g$/.test(ext))) return null;

    try {
      if (isHeicExt(attach.extension)) {
        const imgData = await this.app.vault.readBinary(attach);
        const decoded = await decodeHeic(imgData);
        if (!decoded) {
          console.warn("[AttachHub] HEIC decode failed, skipping conversion");
          return null;
        }
        const resize: ResizeOpts = {
          mode: (this.settings.resizeMode || "disabled") as ResizeOpts["mode"],
          value: this.settings.resizeValue || 0,
        };
        return await convertImage(decoded, target, this.settings.quality, resize);
      }

      // Regular image (JPG/PNG/BMP/GIF/etc.) — Canvas API
      const imgData = await this.app.vault.readBinary(attach);
      const resize: ResizeOpts = {
        mode: (this.settings.resizeMode || "disabled") as ResizeOpts["mode"],
        value: this.settings.resizeValue || 0,
      };
      return await convertImage(imgData, target, this.settings.quality, resize);
    } catch (e: any) {
      console.error("[AttachHub] Image conversion error:", e);
      return null;
    }
  }

  private async _isHeicAnimated(attach: TFile): Promise<boolean> {
    try {
      const basePath = (this.app.vault.adapter as any).basePath as string;
      if (!basePath) return false;
      const absPath = require("path").join(basePath, attach.path);
      return await isAnimatedHeic(absPath);
    } catch (_) {
      return false;
    }
  }

  /**
   * Directly patch the source note to replace old attachment references with the new path.
   * fileManager.renameFile depends on resolvedLinks which may be stale right after a paste,
   * so we do a manual text replacement as a reliable fallback.
   */
  private async _patchSourceNoteLink(source: TFile, oldAttachPath: string, newAttachPath: string): Promise<void> {
    try {
      let content = await this.app.vault.read(source);
      const oldName = pBase(oldAttachPath);
      const newName = pBase(newAttachPath);
      if (oldName === newName) return;

      const noteDir = pDir(source.path);
      const oldRel = relative(noteDir, oldAttachPath);
      const newRel = relative(noteDir, newAttachPath);

      let changed = false;

      // Wikilink: ![[oldName]] or ![[oldPath]]
      const wikiPatterns = [
        `![[${oldName}]]`,
        `![[${oldAttachPath}]]`,
        `[[${oldName}]]`,
        `[[${oldAttachPath}]]`,
      ];
      for (const pat of wikiPatterns) {
        if (content.includes(pat)) {
          const replacement = pat.startsWith("!") ? `![[${newName}]]` : `[[${newName}]]`;
          content = content.split(pat).join(replacement);
          changed = true;
        }
      }

      // Markdown link: ![...](oldRel) or ![...](encoded)
      const mdPatterns = [oldRel, encodeURI(oldRel), oldName, encodeURI(oldName)];
      for (const p of mdPatterns) {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(!\\[[^\\]]*\\])\\(${escaped}\\)`, "g");
        if (re.test(content)) {
          content = content.replace(re, `$1(${newRel})`);
          changed = true;
        }
      }

      if (changed) {
        this._writing.add(source.path);
        try {
          await this.app.vault.modify(source, content);
        } finally {
          setTimeout(() => this._writing.delete(source.path), 2000);
        }
      }
    } catch (e) {
      console.error("[AttachHub] patch source note failed:", e);
    }
  }

  private async _updateFMAfterRename(source: TFile, oldAttachPath: string, newAttachPath: string): Promise<void> {
    let content: string;
    try { content = await this.app.vault.read(source); } catch (_) { return; }
    const fm = parseFM(content);
    if (!fm) return;
    const noteDir = pDir(source.path);
    const fmt = this.settings.pathFormat || "plain";
    const upd: Record<string, string> = {};
    for (const field of this.settings.trackedFields) {
      const val = fm[field];
      if (typeof val !== "string" || !val) continue;
      const plain = stripLink(val) || val;
      const resolved = resolve(noteDir, plain);
      if (resolved && normalizePath(resolved) === normalizePath(oldAttachPath)) {
        upd[field] = fmtPath(relative(noteDir, newAttachPath), fmt);
      }
    }
    if (Object.keys(upd).length) {
      this._writing.add(source.path);
      try { await writeFM(this.app, source, upd); } finally {
        setTimeout(() => this._writing.delete(source.path), 2000);
      }
      const newFM = await getFM(this.app, source);
      if (newFM) this._updateNoteIndex(source.path, extractResolvedPaths(newFM, this.settings.trackedFields, noteDir));
    }
  }

  // ── Frontmatter sync ──

  private async _onFMChange(file: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return;
    this._updateNoteIndex(file.path, extractResolvedPaths(fm, this.settings.trackedFields, pDir(file.path)));
    await this._autoProcessFM(file, fm, null);
  }

  private async _onMdxModify(file: TFile): Promise<void> {
    let content: string;
    try { content = await this.app.vault.cachedRead(file); } catch (_) { return; }
    const section = fmSection(content);
    if (!section || this._mdxHash.get(file.path) === section) return;
    this._mdxHash.set(file.path, section);
    const fm = parseFM(content);
    if (!fm) return;
    this._updateNoteIndex(file.path, extractResolvedPaths(fm, this.settings.trackedFields, pDir(file.path)));
    await this._autoProcessFM(file, fm, content);
  }

  private async _autoProcessFM(file: TFile, fm: Record<string, any>, content: string | null): Promise<void> {
    const fmt = this.settings.pathFormat || "plain";
    const noteDir = pDir(file.path);
    const upd: Record<string, string> = {};
    for (const field of this.settings.trackedFields) {
      const val = fm[field];
      if (typeof val !== "string" || !val) continue;
      const plain = stripLink(val) || val;
      if (plain.startsWith("http")) continue;
      const resolved = resolve(noteDir, plain);
      if (!resolved) continue;
      const formatted = fmtPath(relative(noteDir, resolved), fmt);
      if (formatted !== val) upd[field] = formatted;
    }
    if (!Object.keys(upd).length) return;
    this._writing.add(file.path);
    try {
      if (content && file.extension !== "md") {
        let c = content;
        for (const [k, v] of Object.entries(upd)) c = replaceFMField(c, k, v);
        if (c !== content) await this.app.vault.modify(file, c);
      } else {
        await writeFM(this.app, file, upd);
      }
    } finally {
      setTimeout(() => this._writing.delete(file.path), 2000);
    }
    const newFM = await getFM(this.app, file);
    if (newFM) this._updateNoteIndex(file.path, extractResolvedPaths(newFM, this.settings.trackedFields, noteDir));
  }

  // ── Note move ──

  private _rewriteRelPath(oldDir: string, newDir: string, relPath: string): string | null {
    if (!relPath || relPath.startsWith("http://") || relPath.startsWith("https://")) return null;
    const decoded = decodeURI(relPath);
    const abs = resolve(oldDir, decoded);
    if (!abs) return null;
    if (!this.app.vault.getAbstractFileByPath(abs)) return null;
    const newRel = relative(newDir, abs);
    return newRel === decoded ? null : newRel;
  }

  private async _handleNoteMove(file: TFile, oldPath: string): Promise<void> {
    const oldDir = pDir(oldPath), newDir = pDir(file.path);
    if (oldDir === newDir) return;

    // Brief delay: let Obsidian finish its own link updates for .md files
    await new Promise(r => setTimeout(r, 300));

    const freshFile = this.app.vault.getAbstractFileByPath(file.path);
    if (!(freshFile instanceof TFile)) return;

    let content: string;
    try { content = await this.app.vault.read(freshFile); } catch (_) { return; }

    let changed = false;

    // ── 1. Update frontmatter tracked fields ──
    const fm = parseFM(content);
    if (fm) {
      for (const field of this.settings.trackedFields) {
        const val = fm[field];
        if (typeof val !== "string" || !val) continue;
        const plain = stripLink(val) || val;
        const newRel = this._rewriteRelPath(oldDir, newDir, plain);
        if (newRel) {
          const formatted = fmtPath(newRel, this.settings.pathFormat || "plain");
          content = replaceFMField(content, field, formatted);
          changed = true;
        }
      }
    }

    // ── 2. Update body relative links ──
    // Markdown image/links: ![alt](path) or [text](path)
    content = content.replace(
      /(!?\[[^\]]*\])\(([^)]+)\)/g,
      (_match, prefix: string, linkPath: string) => {
        const trimmed = linkPath.split(/\s+["']/)[0]; // strip title like "title"
        const newRel = this._rewriteRelPath(oldDir, newDir, trimmed);
        if (!newRel) return _match;
        changed = true;
        const rest = linkPath.slice(trimmed.length);
        return `${prefix}(${encodeURI(newRel)}${rest})`;
      },
    );

    // Wikilinks with relative paths: ![[../path/file]] or [[../path/file]]
    content = content.replace(
      /(!?\[\[)([^\]|]+)((?:\|[^\]]*)?)\]\]/g,
      (_match, open: string, linkPath: string, alias: string) => {
        if (!linkPath.includes("/")) return _match; // short name, not a path
        const newRel = this._rewriteRelPath(oldDir, newDir, linkPath);
        if (!newRel) return _match;
        changed = true;
        return `${open}${newRel}${alias}]]`;
      },
    );

    if (changed) {
      this._writing.add(freshFile.path);
      try {
        await this.app.vault.modify(freshFile, content);
      } finally {
        setTimeout(() => this._writing.delete(freshFile.path), 2000);
      }
      const count = Object.keys(fm ? this.settings.trackedFields.filter(f => fm[f]) : []).length;
      if (!this.settings.disableNotification) new Notice(`已更新相对路径：${pBase(freshFile.path)}`);
      const newFM = parseFM(content);
      if (newFM) this._updateNoteIndex(freshFile.path, extractResolvedPaths(newFM, this.settings.trackedFields, newDir));
    }
  }

  // ── Attachment rename ──

  private async _handleAttachRename(file: TFile, oldPath: string): Promise<void> {
    const normOld = normalizePath(oldPath), normNew = normalizePath(file.path);
    const notes = this._getNotesFor(normOld);
    if (!notes.size) return;
    for (const notePath of notes) {
      const nf = this.app.vault.getAbstractFileByPath(notePath);
      if (!nf || !(nf instanceof TFile)) continue;
      const fm = await getFM(this.app, nf);
      if (!fm) continue;
      const noteDir = pDir(notePath);
      const upd: Record<string, string> = {};
      for (const field of this.settings.trackedFields) {
        const val = fm[field];
        if (typeof val !== "string" || !val) continue;
        const p = stripLink(val) || val;
        const r = resolve(noteDir, p);
        if (r && normalizePath(r) === normOld)
          upd[field] = fmtPath(relative(noteDir, normNew), this.settings.pathFormat || "plain");
      }
      if (Object.keys(upd).length) {
        this._writing.add(notePath);
        try { await writeFM(this.app, nf, upd); } finally {
          setTimeout(() => this._writing.delete(notePath), 2000);
        }
        const newMap = new Map<string, string>();
        for (const [fld, ap] of this._noteFields.get(notePath) || new Map()) {
          newMap.set(fld, normalizePath(ap) === normOld ? normNew : ap);
        }
        this._updateNoteIndex(notePath, newMap);
      }
    }
  }

  // ── Attachment delete ──

  private async _onAttachDelete(file: TFile): Promise<void> {
    const dp = normalizePath(file.path);
    const notes = this._getNotesFor(dp);
    if (!notes.size) return;
    let n = 0;
    for (const notePath of notes) {
      const nf = this.app.vault.getAbstractFileByPath(notePath);
      if (!nf || !(nf instanceof TFile)) continue;
      const fm = await getFM(this.app, nf);
      if (!fm) continue;
      const noteDir = pDir(notePath);
      const clr: Record<string, string> = {};
      for (const field of this.settings.trackedFields) {
        const val = fm[field];
        if (typeof val !== "string" || !val) continue;
        const p = stripLink(val) || val;
        const r = resolve(noteDir, p);
        if (r && normalizePath(r) === dp) clr[field] = "";
      }
      if (Object.keys(clr).length && (await writeFM(this.app, nf, clr))) n++;
    }
    this._idx.delete(dp);
    if (n && !this.settings.disableNotification) new Notice(`已清理 ${n} 个笔记的字段`);
  }

  // ── Clean empty folder ──

  private async _cleanOldAttachFolder(notePath: string): Promise<void> {
    const setting = getOverride(this.settings, notePath);
    const obsFolder = (this.app.vault as any).getConfig("attachmentFolderPath") || "";
    const noteDir = pDir(notePath);
    const sub = resolveVars(setting.attachmentPath || "", {
      dateFormat: this.settings.dateFormat,
      noteName: pStem(notePath),
      noteDir,
      parentName: pBase(noteDir),
    });
    const root = getRootPath(noteDir, setting, obsFolder);
    const old = normalizePath(pJoin(root, sub));
    if (old && (await isEmptyFolder(this.app.vault.adapter, old))) {
      try { await this.app.vault.adapter.rmdir(old, true); } catch (_) {}
    }
  }

  // ── Paste to frontmatter ──

  private async _pasteFM(noteFile: TFile): Promise<void> {
    const clip = await clipImage();
    if (!clip) { new Notice("剪贴板中没有图片"); return; }
    const fields = this.settings.trackedFields.filter(f => f.trim());
    if (!fields.length) { new Notice("没有配置追踪字段"); return; }

    const doIt = async (field: string) => {
      try {
        const setting = getOverride(this.settings, noteFile.path);
        const obsFolder = (this.app.vault as any).getConfig("attachmentFolderPath") || "";
        const attachDir = computeAttachPath(noteFile, clip.ext, setting, this.settings.dateFormat, obsFolder);
        let name = await computeAttachName(noteFile, null, setting, this.settings.dateFormat, this.app.vault.adapter);
        name += "." + clip.ext;
        await ensureFolder(this.app.vault.adapter, attachDir);
        const dedupName = await dedup(name, attachDir, this.app.vault.adapter);
        const dst = normalizePath(pJoin(attachDir, dedupName));
        await this.app.vault.createBinary(dst, clip.buf);
        const rel = relative(pDir(noteFile.path), dst);
        const fmt = fmtPath(rel, this.settings.pathFormat || "plain");
        this._writing.add(noteFile.path);
        try { await writeFM(this.app, noteFile, { [field]: fmt }); } finally {
          setTimeout(() => this._writing.delete(noteFile.path), 2000);
        }
        new Notice(`图片已保存 → ${field}: ${pBase(dst)}`);
      } catch (e: any) {
        new Notice(`粘贴失败：${e.message}`);
      }
    };

    if (fields.length === 1) await doIt(fields[0]);
    else new FieldPicker(this.app, fields, doIt).open();
  }

  // ── Scan & fix ──

  private async _scanFixAll(): Promise<void> {
    const all = this.app.vault.getFiles();
    const notes = all.filter(isNote);
    let fixed = 0;
    for (const nf of notes) {
      const fm = await getFM(this.app, nf);
      if (!fm) continue;
      const nd = pDir(nf.path);
      const fix: Record<string, string> = {};
      for (const field of this.settings.trackedFields) {
        const val = fm[field];
        if (typeof val !== "string" || !val) continue;
        const p = stripLink(val) || val;
        if (p.startsWith("http")) continue;
        const r = resolve(nd, p);
        if (!r || this.app.vault.getAbstractFileByPath(r)) continue;
        const fn = pBase(p);
        const found = all.find(f => isAttach(f) && pBase(f.path) === fn);
        if (found) fix[field] = fmtPath(relative(nd, found.path), this.settings.pathFormat || "plain");
      }
      if (Object.keys(fix).length && (await writeFM(this.app, nf, fix))) fixed++;
    }
    new Notice(`已修复 ${fixed} 个笔记`);
    this._buildIndex();
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

    if (!data._migrated && !data.attachPath) {
      const migrated = await migrateFromAM(this.app.vault.adapter as any, this.settings);
      if (migrated) {
        await this.saveSettings();
        new Notice("已导入 Attachment Management 插件设置");
      }
    }

    if ((data as any).renameFormat) {
      this.settings.attachPath.attachFormat = (data as any).renameFormat;
      this.settings.dateFormat = (data as any).renameDateFormat || this.settings.dateFormat;
      delete (this.settings as any).renameFormat;
      delete (this.settings as any).renameDateFormat;
      delete (this.settings as any).renameOnPaste;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
