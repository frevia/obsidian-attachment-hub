import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
globalThis.window = {};
class TFile {
  constructor(path) { this.path = path; }
  get name() { return this.path.split("/").at(-1); }
  get extension() { return this.name.split(".").at(-1); }
  get parent() { return { path: this.path.split("/").slice(0, -1).join("/") }; }
}
const messages = [];
const obsidian = {
  TFile, Plugin: class {}, Notice: class { constructor(text) { messages.push(text); } },
  normalizePath: path => path.replace(/\/+/g, "/"), parseYaml: yaml.load,
  stringifyYaml: value => yaml.dump(value, { noRefs: true, lineWidth: -1 }),
};
async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
    external: ["obsidian", "./modals", "./settings-tab", "./attachment-processor", "./event-handlers"],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(id =>
    id === "obsidian" ? obsidian : id.startsWith("./") ? {} : require(id), module, module.exports);
  return module.exports;
}
const { default: Hub } = await load("src/main.ts");
const { FrontmatterSync } = await load("src/frontmatter-sync.ts");

function fixture(content = "# Note\nbody", attachments = []) {
  const note = new TFile("notes/note.md"), files = new Map([[note.path, { file: note, data: content }]]);
  for (const path of attachments) files.set(path, { file: new TFile(path), data: new ArrayBuffer(0) });
  const indexes = [], calls = [];
  const plugin = new Hub();
  plugin.settings = {
    trackedFields: ["cover"], pathFormat: "plain", attachPath: {
      saveAttE: "obsFolder", attachFormat: "clipboard", extensionOverride: [],
    }, overridePath: {}, dateFormat: "YYYYMMDD", excludePathsArray: [],
  };
  plugin.indexManager = { buildIndex: () => calls.push("buildIndex") };
  plugin.app = {
    getConfig: () => "attachments",
    metadataCache: { getFileCache: () => ({ frontmatter: { cover: "stale.jpg" } }) },
    vault: {
      adapter: { exists: async path => path === "attachments" || files.has(path), mkdir: async () => {} },
      getFiles: () => [...files.values()].map(x => x.file),
      getAbstractFileByPath: path => files.get(path)?.file,
      read: async file => files.get(file.path).data,
      createBinary: async (path, data) => {
        if (files.has(path)) throw Error("exists");
        const file = new TFile(path); files.set(path, { file, data }); return file;
      },
      process: async (file, transform) => {
        const entry = files.get(file.path); entry.data = transform(entry.data); return entry.data;
      },
    },
  };
  const sync = new FrontmatterSync(plugin, {
    updateNoteIndex: (...args) => indexes.push(args), getNotesFor: () => new Set([note.path]),
    removeFromIndex: path => calls.push(path),
  }, new Set());
  return { plugin, note, files, sync, indexes, calls };
}

test("scan leaves ambiguous filenames untouched and reports them", async () => {
  const f = fixture("---\ncover: ../missing/cover.jpg\n---\nbody", ["attachments/private/cover.jpg", "site/attachments/cover.jpg"]);
  await f.plugin._scanFixAll();
  assert.equal(yaml.load(f.files.get(f.note.path).data.split("---")[1]).cover, "../missing/cover.jpg");
  assert.match(messages.at(-1), /跳过 1 个重名引用/);
});

test("scan repairs unique filenames using current YAML and keeps nested values", async () => {
  const f = fixture("---\ncover: ../missing/unique.jpg\nmetadata:\n  cover: private.jpg\n---\nbody", ["attachments/unique.jpg"]);
  await f.plugin._scanFixAll();
  const parsed = yaml.load(f.files.get(f.note.path).data.split("---")[1]);
  assert.equal(parsed.cover, "../attachments/unique.jpg");
  assert.equal(parsed.metadata.cover, "private.jpg");
  assert.match(messages.at(-1), /已修复 1 个笔记/);
});

test("paste-to-frontmatter creates missing YAML and retains the existing body", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { read: async () => [{ types: ["image/png"], getType: async () => new Blob([new Uint8Array([1])]) }] },
  } });
  const f = fixture();
  await f.plugin._pasteFM(f.note);
  const content = f.files.get(f.note.path).data;
  assert.equal(yaml.load(content.split("---")[1]).cover, "../attachments/clipboard.png");
  assert.match(content, /# Note\nbody/);
  assert.ok(f.files.has("attachments/clipboard.png"));
});

test("frontmatter updates read current text, preserve nested values and refresh the index", async () => {
  const f = fixture('---\ncover: "![[../attachments/image.jpg]]"\nmetadata:\n  cover: nested.jpg\n---\nlatest prose');
  await f.sync.onFMChange(f.note);
  const content = f.files.get(f.note.path).data;
  const parsed = yaml.load(content.split("---")[1]);
  assert.equal(parsed.cover, "../attachments/image.jpg");
  assert.equal(parsed.metadata.cover, "nested.jpg");
  assert.match(content, /latest prose/);
  assert.equal(f.indexes.at(-1)[1].get("cover"), "attachments/image.jpg");
});

test("attachment rename does not overwrite a recently edited cover with stale metadata", async () => {
  const f = fixture("---\ncover: ../attachments/user-choice.jpg\n---\nbody");
  await f.sync.handleAttachRename(new TFile("attachments/new.jpg"), "attachments/stale.jpg");
  assert.equal(yaml.load(f.files.get(f.note.path).data.split("---")[1]).cover, "../attachments/user-choice.jpg");
});

test("dispose before the atomic callback prevents frontmatter updates", async () => {
  const f = fixture('---\ncover: "![[../attachments/image.jpg]]"\n---\nbody');
  const before = f.files.get(f.note.path).data;
  f.plugin.app.vault.process = async (file, transform) => {
    f.sync.dispose(); f.files.get(file.path).data = transform(before);
  };
  await f.sync.onFMChange(f.note);
  assert.equal(f.files.get(f.note.path).data, before);
  assert.deepEqual(f.indexes, []);
});

test("plugin unload disposes every background module", () => {
  const f = fixture();
  const disposed = [];
  for (const key of ["eventHandlers", "attachmentProcessor", "frontmatterSync"]) f.plugin[key] = { dispose: () => disposed.push(key) };
  f.plugin.onunload();
  assert.deepEqual(disposed, ["eventHandlers", "attachmentProcessor", "frontmatterSync"]);
});
