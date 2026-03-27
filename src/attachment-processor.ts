import { Plugin, TFile, normalizePath, Notice } from "obsidian";

export interface ProcessorPlugin extends Plugin {
  saveSettings(): Promise<void>;
}
import {
  AttachmentHubSettings,
  isImage,
  isVideo,
  isHeicExt,
  isPasted,
  getExtOverride,
  getOverride,
  saveOrigName,
  normalizePathFormat,
} from "./settings";
import { convertVideoFile, isAnimatedHeic, VideoTarget } from "./ffmpeg-handler";
import { convertImage, ImageFormat, ResizeOpts } from "./image-processor";
import { decodeHeic } from "./heic-handler";
import {
  pDir, pBase, pExt, pStem, pJoin,
  relative,
  md5sum,
  computeAttachPath,
  computeAttachName,
  dedup,
  parseFM, writeFM,
  stripLink, fmtPath,
  ensureFolder,
} from "./utils";
import { pJoin as join } from "./path-utils";

interface AdapterWithBasePath {
  basePath?: string;
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

export class AttachmentProcessor {
  private plugin: ProcessorPlugin;
  private settings: AttachmentHubSettings;
  private _writing: Set<string>;

  constructor(plugin: ProcessorPlugin, settings: AttachmentHubSettings, writing: Set<string>) {
    this.plugin = plugin;
    this.settings = settings;
    this._writing = writing;
  }

  async processNewAttach(attach: TFile, source: TFile): Promise<void> {
    if (source.parent && this.isExcluded(source.parent.path)) return;
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
          await this.plugin.app.vault.modifyBinary(attach, result.data);
          convertedExt = result.ext;
        }
      }
    } else if (isHeicExt(attach.extension)) {
      const animated = shouldTryFFmpeg && (await this._isHeicAnimated(attach));
      if (animated) {
        const result = await this._convertVideoData(attach);
        if (result) {
          await this.plugin.app.vault.modifyBinary(attach, result.data);
          convertedExt = result.ext;
        }
      } else if (shouldConvertImage) {
        const result = await this._convertImageData(attach);
        if (result) {
          await this.plugin.app.vault.modifyBinary(attach, result.data);
          convertedExt = result.ext;
        }
      }
    } else if (shouldConvertImage && isImage(attach.extension)) {
      const result = await this._convertImageData(attach);
      if (result) {
        await this.plugin.app.vault.modifyBinary(attach, result.data);
        convertedExt = result.ext;
      }
    }

    // Use new extension if converted, otherwise keep original
    const finalExt = convertedExt || attach.extension;

    const obsFolder = getAttachmentFolderPath(this.plugin.app);
    const attachPath = computeAttachPath(source, finalExt, setting, this.settings.dateFormat, obsFolder);
    let attachName = await computeAttachName(
      source, attach, setting, this.settings.dateFormat, this.plugin.app.vault.adapter,
    );
    attachName += "." + finalExt;

    await ensureFolder(this.plugin.app.vault.adapter, attachPath);
    const dedupName = await dedup(attachName, attachPath, this.plugin.app.vault.adapter);
    const dst = normalizePath(pJoin(attachPath, dedupName));

    const oldPath = attach.path;
    const origBasename = pStem(attach.path);
    try {
      await this.plugin.app.fileManager.renameFile(attach, dst);
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

    const renamedFile = this.plugin.app.vault.getAbstractFileByPath(dst);
    if (renamedFile instanceof TFile) {
      const md5Val = await md5sum(this.plugin.app.vault.adapter, renamedFile);
      saveOrigName(this.settings, setting, pExt(dst), { n: origBasename, md5: md5Val });
      await this.plugin.saveSettings();
    }

    await this._updateFMAfterRename(source, oldPath, dst);
  }

  /**
   * Convert video data via system FFmpeg. Returns raw result, does NOT touch the vault file.
   */
  private async _convertVideoData(attach: TFile): Promise<{ data: ArrayBuffer; ext: string } | null> {
    try {
      const basePath = (this.plugin.app.vault.adapter as AdapterWithBasePath).basePath;
      if (!basePath) return null;
      const absPath = join(basePath, attach.path);
      return await convertVideoFile(absPath, attach.extension, {
        ffmpegPath: this.settings.ffmpegPath,
        target: this.settings.videoConvertTo as VideoTarget,
        quality: this.settings.quality,
        resizeValue: this.settings.resizeMode !== "disabled" ? this.settings.resizeValue : 0,
      });
    } catch (e: unknown) {
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
        const imgData = await this.plugin.app.vault.readBinary(attach);
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
      const imgData = await this.plugin.app.vault.readBinary(attach);
      const resize: ResizeOpts = {
        mode: (this.settings.resizeMode || "disabled") as ResizeOpts["mode"],
        value: this.settings.resizeValue || 0,
      };
      return await convertImage(imgData, target, this.settings.quality, resize);
    } catch (e: unknown) {
      console.error("[AttachHub] Image conversion error:", e);
      return null;
    }
  }

  private async _isHeicAnimated(attach: TFile): Promise<boolean> {
    try {
      const basePath = (this.plugin.app.vault.adapter as AdapterWithBasePath).basePath;
      if (!basePath) return false;
      const absPath = join(basePath, attach.path);
      return await isAnimatedHeic(absPath);
    } catch {
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
      let content = await this.plugin.app.vault.read(source);
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
          await this.plugin.app.vault.modify(source, content);
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
    try { content = await this.plugin.app.vault.read(source); } catch { return; }
    const fm = parseFM(content);
    if (!fm) return;
    const noteDir = pDir(source.path);
    const fmt = normalizePathFormat(this.settings.pathFormat);
    const upd: Record<string, string> = {};
    for (const field of this.settings.trackedFields) {
      const val = fm[field];
      if (typeof val !== "string" || !val) continue;
      const plain = stripLink(val) || val;
      const resolved = this.resolve(noteDir, plain);
      if (resolved && normalizePath(resolved) === normalizePath(oldAttachPath)) {
        upd[field] = fmtPath(relative(noteDir, newAttachPath), fmt);
      }
    }
    if (Object.keys(upd).length) {
      this._writing.add(source.path);
      try { await writeFM(this.plugin.app, source, upd); } finally {
        setTimeout(() => this._writing.delete(source.path), 2000);
      }
      const newFM = await this.getFM(source);
      if (newFM) this.updateNoteIndex(source.path, this.extractResolvedPaths(newFM, this.settings.trackedFields, noteDir));
    }
  }

  // Helper methods that will be implemented in the main plugin
  private isExcluded(dirPath: string): boolean {
    for (const ep of this.settings.excludePathsArray || []) {
      if (!ep) continue;
      if (this.settings.excludeSubpaths && dirPath.startsWith(ep)) return true;
      if (dirPath === ep) return true;
    }
    return false;
  }

  private resolve(fromDir: string, rel: string): string | null {
    if (!rel || rel.startsWith("http://") || rel.startsWith("https://")) return null;
    const s = fromDir ? fromDir.split("/") : [];
    for (const p of rel.split("/")) {
      if (p === "..") s.pop();
      else if (p !== "." && p) s.push(p);
    }
    return normalizePath(s.join("/"));
  }

  private async getFM(file: TFile): Promise<Record<string, unknown> | null> {
    const c = this.plugin.app.metadataCache.getFileCache(file);
    if (c?.frontmatter) return c.frontmatter;
    try {
      return parseFM(await this.plugin.app.vault.cachedRead(file));
    } catch {
      return null;
    }
  }

  private updateNoteIndex(notePath: string, newMap: Map<string, string> | null): void {
    // This will be implemented in the main plugin
  }

  private extractResolvedPaths(
    fm: Record<string, unknown>,
    trackedFields: string[],
    noteDir: string,
  ): Map<string, string> {
    const result = new Map<string, string>();
    for (const field of trackedFields) {
      const val = fm[field];
      if (typeof val !== "string" || !val) continue;
      const plain = stripLink(val) || val;
      if (plain.startsWith("http://") || plain.startsWith("https://")) continue;
      const resolved = this.resolve(noteDir, plain);
      if (resolved) result.set(field, normalizePath(resolved));
    }
    return result;
  }
}
