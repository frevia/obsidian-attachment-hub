import { Plugin, TFile, normalizePath, Notice } from "obsidian";
import { Buffer } from "node:buffer";
import {
  AttachmentHubSettings, isImage, isVideo, isHeicExt, isPasted,
  getExtOverride, getOverride, containsOrigVar, saveOrigName, normalizePathFormat,
  shouldConvertImageExt, isExcluded,
} from "./settings";
import { convertVideoFile, copyMetadataToBuffer, isAnimatedHeic, VideoTarget } from "./ffmpeg-handler";
import { convertImage, ImageFormat } from "./image-processor";
import { decodeHeic } from "./heic-handler";
import {
  pDir, pBase, pStem, pJoin, relative, resolve, md5sum,
  computeAttachPath, computeAttachName, dedup, parseFM, getFM,
  replaceFMField, stripLink, fmtPath, extractResolvedPaths, ensureFolder,
  getAttachmentFolderPath,
} from "./utils";
import { IndexManager } from "./index-manager";

export interface ProcessorPlugin extends Plugin {
  saveSettings(): Promise<void>;
}

export class AttachmentProcessor {
  private disposed = false;
  private created = new Set<string>();

  constructor(
    private plugin: ProcessorPlugin,
    private settings: AttachmentHubSettings,
    private writing: Set<string>,
    private index?: IndexManager,
  ) {}

  dispose(): void {
    this.disposed = true;
    this.created.clear();
  }

  consumeCreated(path: string): boolean {
    return this.created.delete(path);
  }

  async processNewAttach(attach: TFile, source: TFile): Promise<TFile> {
    if (this.disposed || (source.parent && isExcluded(source.parent.path, this.settings))) return attach;
    const setting = getOverride(this.settings, source.path);
    if (!getExtOverride(attach.extension, setting) && !isImage(attach.extension) &&
        !isVideo(attach.extension) && !isHeicExt(attach.extension) && !isPasted(attach)) return attach;

    let output = attach;
    try {
      let converted: { data: ArrayBuffer; ext: string } | null = null;
      const videoEnabled = Boolean(this.settings.ffmpegPath) && this.settings.videoConvertTo !== "disabled";
      const imageEnabled = this.settings.convertTo !== "disabled" && shouldConvertImageExt(this.settings, attach.extension);
      const convertVideo = isVideo(attach.extension) && videoEnabled;
      const convertStill = (isImage(attach.extension) || isHeicExt(attach.extension)) && imageEnabled;
      if (convertVideo || (convertStill && isHeicExt(attach.extension) && videoEnabled && await this._isHeicAnimated(attach))) {
        converted = await this._convertVideoData(attach);
      } else if (convertStill) {
        converted = await this._convertImageData(attach);
      }
      if (this.disposed) return attach;
      if ((convertVideo || convertStill) && !converted) throw new Error("转换未完成");

      const ext = converted?.ext || attach.extension;
      const folder = computeAttachPath(source, ext, setting, this.settings.dateFormat, getAttachmentFolderPath(this.plugin.app));
      const name = await computeAttachName(source, attach, setting, this.settings.dateFormat, this.plugin.app.vault.adapter, undefined, this.settings.filenamePrefix);
      if (this.disposed) return attach;
      await ensureFolder(this.plugin.app.vault.adapter, folder);
      const unique = await dedup(`${name}.${ext}`, folder, this.plugin.app.vault.adapter, converted ? undefined : attach.path);
      if (this.disposed) return attach;
      const destination = normalizePath(pJoin(folder, unique));
      const oldPath = attach.path;
      const originalName = pStem(oldPath);

      if (converted) {
        // Keep the original intact until a separate output and its reference are committed.
        this.created.add(destination);
        try {
          output = await this.plugin.app.vault.createBinary(destination, converted.data);
        } catch (error) {
          this.created.delete(destination);
          throw error;
        }
        if (this.disposed) return output;
        const persisted = await this.plugin.app.vault.readBinary(output);
        if (this.disposed) return output;
        if (!Buffer.from(persisted).equals(Buffer.from(converted.data))) throw new Error("新文件校验失败，原图已保留");
        const linked = await this._patchSourceNoteLink(source, oldPath, destination);
        if (this.disposed) return output;
        if (!linked) throw new Error("引用未能更新，新文件和原图均已保留");
        await this.updateIndex(source);
        if (this.disposed) return output;
        const otherReferences = Object.entries(this.plugin.app.metadataCache.resolvedLinks || {})
          .some(([note, links]) => note !== source.path && Boolean(links[oldPath]));
        // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Converted originals must remain recoverable even when permanent deletion is configured.
        if (!otherReferences) await this.plugin.app.vault.trash(attach, true);
      } else if (oldPath !== destination) {
        await this.plugin.app.fileManager.renameFile(attach, destination);
        if (this.disposed) return attach;
        await this._patchSourceNoteLink(source, oldPath, destination);
        await this.updateIndex(source);
      }

      if (this.disposed) return output;
      if (containsOrigVar(setting, ext)) {
        const hash = await md5sum(this.plugin.app.vault.adapter, output);
        if (this.disposed) return output;
        saveOrigName(this.settings, setting, ext, { n: originalName, md5: hash });
        await this.plugin.saveSettings();
      }
      if (!this.settings.disableNotification) new Notice(`${converted ? "已转换" : "已处理"} ${pBase(oldPath)} → ${unique}`);
    } catch (error) {
      console.error("[AttachHub] attachment processing failed:", attach.path, error);
      if (!this.disposed) new Notice(`附件处理未完成，原始数据已保留：${error instanceof Error ? error.message : String(error)}`);
    }
    return output;
  }

  private absolutePath(attach: TFile): string | null {
    const adapter = this.plugin.app.vault.adapter as { basePath?: string };
    return adapter.basePath ? `${adapter.basePath}/${attach.path}` : null;
  }

  private async _convertVideoData(attach: TFile): Promise<{ data: ArrayBuffer; ext: string } | null> {
    const path = this.absolutePath(attach);
    if (!path || this.disposed) return null;
    return convertVideoFile(path, attach.extension, {
      ffmpegPath: this.settings.ffmpegPath,
      target: this.settings.videoConvertTo as VideoTarget,
      quality: this.settings.quality,
      resizeValue: this.settings.resizeMode !== "disabled" ? this.settings.resizeValue : 0,
      preserveExif: this.settings.preserveExif,
      preserveGps: this.settings.preserveGps,
    });
  }

  private async _convertImageData(attach: TFile): Promise<{ data: ArrayBuffer; ext: string } | null> {
    if (this.disposed || this.settings.convertTo === "disabled") return null;
    if (!["webp", "jpg", "png"].includes(this.settings.convertTo)) throw new Error("无效的图片转换目标");
    const original = await this.plugin.app.vault.readBinary(attach);
    if (this.disposed) return null;
    const decoded = isHeicExt(attach.extension) ? await decodeHeic(original) : original;
    if (this.disposed) return null;
    if (!decoded) {
      new Notice(`HEIC 转换失败，已保留原图：${attach.name}`);
      return null;
    }
    const converted = await convertImage(decoded, this.settings.convertTo as ImageFormat, this.settings.quality, {
      mode: this.settings.resizeMode as "disabled" | "width" | "height" | "longest" | "shortest",
      value: this.settings.resizeValue,
    });
    if (!converted || this.disposed) return null;
    if (this.settings.preserveExif) {
      const data = await copyMetadataToBuffer(original, attach.extension, converted.data, converted.ext, this.settings.preserveGps);
      return this.disposed ? null : { data, ext: converted.ext };
    }
    return converted;
  }

  private async _isHeicAnimated(attach: TFile): Promise<boolean> {
    const path = this.absolutePath(attach);
    if (!path || this.disposed) return false;
    try { return await isAnimatedHeic(path); } catch { return false; }
  }

  private async _patchSourceNoteLink(source: TFile, oldPath: string, newPath: string): Promise<boolean> {
    if (this.disposed) return false;
    let linked = false;
    this.writing.add(source.path);
    try {
      await this.plugin.app.vault.process(source, current => {
        if (this.disposed) return current;
        if (source.extension === "canvas") {
          const canvas = JSON.parse(current) as { nodes?: Array<{ file?: string; background?: string }> };
          for (const node of canvas.nodes || []) {
            for (const key of ["file", "background"] as const) {
              if (node[key] === oldPath) { node[key] = newPath; linked = true; }
            }
          }
          return linked ? JSON.stringify(canvas, null, "\t") : current;
        }
        const dir = pDir(source.path);
        const oldName = pBase(oldPath), newName = pBase(newPath);
        const oldRel = relative(dir, oldPath), newRel = relative(dir, newPath);
        const targets = new Set([oldName, oldPath, oldRel]);
        let content = current.replace(/(!?\[\[)([^\]|]+)((?:\|[^\]]*)?)\]\]/g,
          (match, open: string, target: string, alias: string) => {
            if (!targets.has(target)) return match;
            linked = true;
            return `${open}${target === oldName ? newName : target === oldPath ? newPath : newRel}${alias}]]`;
          });
        const mdTargets = [...new Set([...targets].flatMap(path => [path, encodeURI(path)]))]
          .map(path => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
        const markdown = new RegExp(`(!?\\[[^\\]]*\\])\\((?:${mdTargets.join("|")})(\\s+["'][^\\n]*["'])?\\)`, "g");
        content = content.replace(markdown, (_match, label: string, title: string | undefined) => {
          linked = true;
          return `${label}(${newRel.split("/").map(encodeURIComponent).join("/")}${title || ""})`;
        });
        const fm = parseFM(current);
        if (fm) {
          for (const field of this.settings.trackedFields) {
            const value = fm[field];
            if (typeof value !== "string") continue;
            const plain = stripLink(value) || value;
            if (resolve(dir, plain) === oldPath || plain === oldPath || plain === oldName) {
              content = replaceFMField(content, field, fmtPath(newRel, normalizePathFormat(this.settings.pathFormat)));
              linked = true;
            }
          }
        }
        return content;
      });
    } finally {
      this.writing.delete(source.path);
    }
    return linked;
  }

  private async updateIndex(source: TFile): Promise<void> {
    if (!this.index || this.disposed || source.extension === "canvas") return;
    const fm = await getFM(this.plugin.app, source);
    if (!this.disposed) this.index.updateNoteIndex(source.path, fm ? extractResolvedPaths(fm, this.settings.trackedFields, pDir(source.path)) : null);
  }
}
