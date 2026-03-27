/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Plugin, TFile, normalizePath } from "obsidian";
import { AttachmentHubSettings } from "./settings";
import { normalizePathFormat } from "./settings";
import {
  pDir,
  parseFM, fmSection, replaceFMField,
  writeFM, getFM,
  stripLink, fmtPath,
  extractResolvedPaths,
} from "./utils";

export class FrontmatterSync {
  private plugin: Plugin;
  private settings: AttachmentHubSettings;
  private _writing: Set<string>;
  private _noteFields: Map<string, Map<string, string>>;
  private _mdxHash: Map<string, string>;

  constructor(
    plugin: Plugin, 
    settings: AttachmentHubSettings, 
    writing: Set<string>,
    noteFields: Map<string, Map<string, string>>,
    mdxHash: Map<string, string>
  ) {
    this.plugin = plugin;
    this.settings = settings;
    this._writing = writing;
    this._noteFields = noteFields;
    this._mdxHash = mdxHash;
  }

  async onFMChange(file: TFile): Promise<void> {
    let fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | null;
    const hasTracked = (data: Record<string, unknown> | null): boolean => {
      if (!data) return false;
      return this.settings.trackedFields.some(field => typeof data[field] === "string" && Boolean(data[field]));
    };
    if (!hasTracked(fm)) {
      try {
        const raw = await this.plugin.app.vault.cachedRead(file);
        const parsed = parseFM(raw);
        if (parsed) fm = parsed;
      } catch {
        // Keep metadata cache value if raw read fails.
      }
    }
    if (!fm) return;
    this.updateNoteIndex(file.path, extractResolvedPaths(fm, this.settings.trackedFields, pDir(file.path)));
    await this._autoProcessFM(file, fm, null);
  }

  async onMdxModify(file: TFile): Promise<void> {
    let content: string;
    try { content = await this.plugin.app.vault.cachedRead(file); } catch { return; }
    const section = fmSection(content);
    if (!section || this._mdxHash.get(file.path) === section) return;
    this._mdxHash.set(file.path, section);
    const fm = parseFM(content);
    if (!fm) return;
    this.updateNoteIndex(file.path, extractResolvedPaths(fm, this.settings.trackedFields, pDir(file.path)));
    await this._autoProcessFM(file, fm, content);
  }

  private async _autoProcessFM(file: TFile, fm: Record<string, unknown>, content: string | null): Promise<void> {
    const fmt = normalizePathFormat(this.settings.pathFormat);
    const noteDir = pDir(file.path);
    const upd: Record<string, string> = {};
    for (const field of this.settings.trackedFields) {
      const val = fm[field];
      if (typeof val !== "string" || !val) continue;
      const plain = stripLink(val) || val;
      if (plain.startsWith("http")) continue;
      const resolved = this.resolve(noteDir, plain);
      if (!resolved) continue;
      const formatted = fmtPath(this.relative(noteDir, resolved), fmt);
      if (formatted !== val) upd[field] = formatted;
    }
    if (!Object.keys(upd).length) return;
    this._writing.add(file.path);
    try {
      if (content && file.extension !== "md") {
        let c = content;
        for (const [k, v] of Object.entries(upd)) c = replaceFMField(c, k, v);
        if (c !== content) await this.plugin.app.vault.modify(file, c);
      } else {
        await writeFM(this.plugin.app, file, upd);
      }
    } finally {
      setTimeout(() => this._writing.delete(file.path), 2000);
    }
    const newFM = await getFM(this.plugin.app, file);
    if (newFM) this.updateNoteIndex(file.path, extractResolvedPaths(newFM, this.settings.trackedFields, noteDir));
  }

  async handleAttachRename(file: TFile, oldPath: string): Promise<void> {
    const normOld = normalizePath(oldPath), normNew = normalizePath(file.path);
    const notes = this.getNotesFor(normOld);
    if (!notes.size) return;
    for (const notePath of notes) {
      const nf = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (!nf || !(nf instanceof TFile)) continue;
      const fm = await getFM(this.plugin.app, nf);
      if (!fm) continue;
      const noteDir = pDir(notePath);
      const upd: Record<string, string> = {};
      for (const field of this.settings.trackedFields) {
        const val = fm[field];
        if (typeof val !== "string" || !val) continue;
        const p = stripLink(val) || val;
        const r = this.resolve(noteDir, p);
        if (r && normalizePath(r) === normOld)
          upd[field] = fmtPath(this.relative(noteDir, normNew), normalizePathFormat(this.settings.pathFormat));
      }
      if (Object.keys(upd).length) {
        this._writing.add(notePath);
        try { await writeFM(this.plugin.app, nf, upd); } finally {
          setTimeout(() => this._writing.delete(notePath), 2000);
        }
        const newMap = new Map<string, string>();
        for (const [fld, ap] of this._noteFields.get(notePath) || new Map()) {
          newMap.set(fld, normalizePath(ap) === normOld ? normNew : ap);
        }
        this.updateNoteIndex(notePath, newMap);
      }
    }
  }

  async handleNoteMove(file: TFile, oldPath: string): Promise<void> {
    const oldDir = pDir(oldPath), newDir = pDir(file.path);
    if (oldDir === newDir) return;

    // Brief delay: let Obsidian finish its own link updates for .md files
    await new Promise(r => setTimeout(r, 300));

    const freshFile = this.plugin.app.vault.getAbstractFileByPath(file.path);
    if (!(freshFile instanceof TFile)) return;

    let content: string;
    try { content = await this.plugin.app.vault.read(freshFile); } catch { return; }

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
          const formatted = fmtPath(newRel, normalizePathFormat(this.settings.pathFormat));
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
        await this.plugin.app.vault.modify(freshFile, content);
      } finally {
        setTimeout(() => this._writing.delete(freshFile.path), 2000);
      }
      const newFM = parseFM(content);
      if (newFM) this.updateNoteIndex(freshFile.path, extractResolvedPaths(newFM, this.settings.trackedFields, newDir));
    }
  }

  async onAttachDelete(file: TFile): Promise<void> {
    const dp = normalizePath(file.path);
    const notes = this.getNotesFor(dp);
    if (!notes.size) return;
    for (const notePath of notes) {
      const nf = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (!nf || !(nf instanceof TFile)) continue;
      const fm = await getFM(this.plugin.app, nf);
      if (!fm) continue;
      const noteDir = pDir(notePath);
      const clr: Record<string, string> = {};
      for (const field of this.settings.trackedFields) {
        const val = fm[field];
        if (typeof val !== "string" || !val) continue;
        const p = stripLink(val) || val;
        const r = this.resolve(noteDir, p);
        if (r && normalizePath(r) === dp) clr[field] = "";
      }
      if (Object.keys(clr).length) await writeFM(this.plugin.app, nf, clr);
    }
    this.removeFromIndex(dp);
  }

  private _rewriteRelPath(oldDir: string, newDir: string, relPath: string): string | null {
    if (!relPath || relPath.startsWith("http://") || relPath.startsWith("https://")) return null;
    const decoded = decodeURI(relPath);
    const abs = this.resolve(oldDir, decoded);
    if (!abs) return null;
    if (!this.plugin.app.vault.getAbstractFileByPath(abs)) return null;
    const newRel = this.relative(newDir, abs);
    return newRel === decoded ? null : newRel;
  }

  // Helper methods that will be implemented in the main plugin
  private resolve(fromDir: string, rel: string): string | null {
    if (!rel || rel.startsWith("http://") || rel.startsWith("https://")) return null;
    const s = fromDir ? fromDir.split("/") : [];
    for (const p of rel.split("/")) {
      if (p === "..") s.pop();
      else if (p !== "." && p) s.push(p);
    }
    return normalizePath(s.join("/"));
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

  private updateNoteIndex(notePath: string, newMap: Map<string, string> | null): void {
    // This will be implemented in the main plugin
  }

  private getNotesFor(ap: string): Set<string> {
    // This will be implemented in the main plugin
    return new Set();
  }

  private removeFromIndex(ap: string): void {
    // This will be implemented in the main plugin
  }
}
