import { Plugin, TFile, normalizePath } from "obsidian";
import { AttachmentHubSettings, normalizePathFormat, isExcluded } from "./settings";
import {
  pDir, resolve, relative, parseFM, replaceFMField, getFM,
  stripLink, fmtPath, extractResolvedPaths,
} from "./utils";
import { IndexManager } from "./index-manager";

interface HubPlugin extends Plugin {
  settings: AttachmentHubSettings;
}

export class FrontmatterSync {
  private disposed = false;

  constructor(private plugin: HubPlugin, private index: IndexManager, private writing: Set<string>) {}

  dispose(): void {
    this.disposed = true;
  }

  private get settings(): AttachmentHubSettings {
    return this.plugin.settings;
  }

  async onFMChange(file: TFile): Promise<void> {
    if (file.parent && isExcluded(file.parent.path, this.settings)) return;
    await this.edit(file, content => this.mapFields(content, path => {
      const absolute = resolve(pDir(file.path), path);
      return absolute ? relative(pDir(file.path), absolute) : null;
    }));
  }

  async onMdxModify(file: TFile): Promise<void> {
    await this.onFMChange(file);
  }

  async handleAttachRename(file: TFile, oldPath: string): Promise<void> {
    const old = normalizePath(oldPath), destination = normalizePath(file.path);
    for (const notePath of [...this.index.getNotesFor(old)]) {
      if (this.disposed) return;
      const note = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (!(note instanceof TFile)) continue;
      const dir = pDir(notePath);
      await this.edit(note, content => this.mapFields(content, path =>
        resolve(dir, path) === old ? relative(dir, destination) : null));
    }
  }

  async onAttachDelete(file: TFile): Promise<void> {
    const deleted = normalizePath(file.path);
    for (const notePath of [...this.index.getNotesFor(deleted)]) {
      if (this.disposed) return;
      const note = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (!(note instanceof TFile)) continue;
      const dir = pDir(notePath);
      await this.edit(note, content => this.mapFields(content, path =>
        resolve(dir, path) === deleted ? "" : null));
    }
    if (!this.disposed) this.index.removeFromIndex(deleted);
  }

  async handleNoteMove(file: TFile, oldPath: string): Promise<void> {
    const oldDir = pDir(oldPath), newDir = pDir(file.path);
    if (oldDir === newDir) { await this.refreshIndex(file); return; }
    // Obsidian may still be finishing its own Markdown link updates.
    await new Promise(resolve => setTimeout(resolve, 300));
    if (this.disposed) return;
    const current = this.plugin.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile)) return;
    await this.edit(current, content => {
      let changed = this.mapFields(content, path => this.rewriteRelative(oldDir, newDir, path));
      changed = changed.replace(/(!?\[[^\]]*\])\(([^)]+)\)/g,
        (match, prefix: string, target: string) => {
          const path = target.split(/\s+["']/)[0];
          const next = this.rewriteRelative(oldDir, newDir, path);
          return next === null ? match : `${prefix}(${encodeURI(next)}${target.slice(path.length)})`;
        });
      return changed.replace(/(!?\[\[)([^\]|]+)((?:\|[^\]]*)?)\]\]/g,
        (match, open: string, path: string, alias: string) => {
          if (!path.includes("/")) return match;
          const next = this.rewriteRelative(oldDir, newDir, path);
          return next === null ? match : `${open}${next}${alias}]]`;
        });
    });
  }

  private rewriteRelative(oldDir: string, newDir: string, path: string): string | null {
    if (!path || /^https?:\/\//.test(path)) return null;
    let decoded: string;
    try { decoded = decodeURI(path); } catch { return null; }
    const absolute = resolve(oldDir, decoded);
    if (!absolute || !this.plugin.app.vault.getAbstractFileByPath(absolute)) return null;
    const next = relative(newDir, absolute);
    return next === decoded ? null : next;
  }

  private mapFields(content: string, map: (path: string) => string | null): string {
    const fm = parseFM(content);
    if (!fm) return content;
    for (const field of this.settings.trackedFields) {
      const value = fm[field];
      if (typeof value !== "string" || !value) continue;
      const plain = stripLink(value) || value;
      if (/^https?:\/\//.test(plain)) continue;
      const next = map(plain);
      if (next === null) continue;
      const formatted = fmtPath(next, normalizePathFormat(this.settings.pathFormat));
      if (formatted !== value) content = replaceFMField(content, field, formatted);
    }
    return content;
  }

  private async edit(file: TFile, transform: (content: string) => string): Promise<void> {
    if (this.disposed || file.extension === "canvas") return;
    this.writing.add(file.path);
    try {
      await this.plugin.app.vault.process(file, current => this.disposed ? current : transform(current));
      await this.refreshIndex(file);
    } catch (error) {
      console.error("[AttachHub] frontmatter update failed:", file.path, error);
    } finally {
      this.writing.delete(file.path);
    }
  }

  private async refreshIndex(file: TFile): Promise<void> {
    if (this.disposed) return;
    const fm = await getFM(this.plugin.app, file);
    if (!this.disposed) this.index.updateNoteIndex(file.path, fm ? extractResolvedPaths(fm, this.settings.trackedFields, pDir(file.path)) : null);
  }
}
