import { App, TFile, normalizePath } from "obsidian";
import { AttachmentHubSettings } from "./settings";
import { extractResolvedPaths } from "./utils";

export class IndexManager {
  private app: App;
  private settings: AttachmentHubSettings;
  private _idx: Map<string, Set<string>>;
  private _noteFields: Map<string, Map<string, string>>;

  constructor(app: App, settings: AttachmentHubSettings, idx: Map<string, Set<string>>, noteFields: Map<string, Map<string, string>>) {
    this.app = app;
    this.settings = settings;
    this._idx = idx;
    this._noteFields = noteFields;
  }

  buildIndex(): void {
    this._idx.clear();
    this._noteFields.clear();
    for (const f of this.app.vault.getFiles()) {
      if (!this.isNote(f)) continue;
      const c = this.app.metadataCache.getFileCache(f);
      const fm = c?.frontmatter;
      if (!fm) continue;
      const map = extractResolvedPaths(fm, this.settings.trackedFields, this.pDir(f.path));
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

  updateNoteIndex(notePath: string, newMap: Map<string, string> | null): void {
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

  removeNoteFromIndex(p: string): void {
    this.updateNoteIndex(p, null);
  }

  getNotesFor(ap: string): Set<string> {
    return this._idx.get(normalizePath(ap)) || new Set();
  }

  removeFromIndex(ap: string): void {
    this._idx.delete(normalizePath(ap));
  }

  // Helper methods
  private isNote(f: unknown): f is TFile {
    return f instanceof TFile && (f.extension === "md" || f.extension === "mdx" || f.extension === "canvas");
  }

  private pDir(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.substring(0, i);
  }
}
