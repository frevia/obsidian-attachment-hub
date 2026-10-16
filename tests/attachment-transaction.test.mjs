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
  normalizePath: path => path.replace(/\/+/g, "/"),
  parseYaml: yaml.load, stringifyYaml: value => yaml.dump(value, { noRefs: true, lineWidth: -1 }),
};
const original = Uint8Array.from([137, 80, 78, 71]).buffer;
const converted = Uint8Array.from([82, 73, 70, 70]).buffer;
let convert = async () => ({ data: converted, ext: "webp" });
let metadata = async (_source, _ext, output) => output;
const result = await build({
  entryPoints: ["src/attachment-processor.ts"], bundle: true, write: false, platform: "node", format: "cjs",
  external: ["obsidian", "./image-processor", "./ffmpeg-handler", "./heic-handler"],
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(id => {
  if (id === "obsidian") return obsidian;
  if (id === "./image-processor") return { convertImage: (...args) => convert(...args) };
  if (id === "./heic-handler") return { decodeHeic: async data => data };
  if (id === "./ffmpeg-handler") return {
    isAnimatedHeic: async () => false, convertVideoFile: async () => null,
    copyMetadataToBuffer: (...args) => metadata(...args),
  };
  return require(id);
}, module, module.exports);
const { AttachmentProcessor } = module.exports;

function fixture(options = {}) {
  const source = new TFile("notes/test.md"), image = new TFile("attachments/source.png");
  const files = new Map([[image.path, { file: image, data: original }],
    [source.path, { file: source, data: options.content ?? "![[source.png|500]]\nuser text" }]]);
  const trash = [], actions = [], queue = [], indexes = [];
  let processor;
  const adapter = {
    basePath: "/Vault",
    exists: async path => files.has(path) || path === "attachments",
    readBinary: async path => files.get(path).data,
    mkdir: async () => {},
  };
  const app = {
    getConfig: () => "attachments",
    metadataCache: { resolvedLinks: options.otherReferences ? { "notes/other.md": { [image.path]: 1 } } : {} },
    vault: {
      adapter,
      readBinary: async file => files.get(file.path).data,
      read: async file => files.get(file.path).data,
      modifyBinary: async () => { throw new Error("must never overwrite original bytes"); },
      createBinary: async (path, data) => {
        if (options.failCreate || files.has(path)) throw new Error("destination exists");
        const file = new TFile(path);
        files.set(path, { file, data: options.corruptOutput ? new ArrayBuffer(1) : data });
        actions.push("create");
        if (!processor.consumeCreated(path)) queue.push(file);
        options.afterCreate?.(processor);
        return file;
      },
      process: async (file, transform) => {
        options.beforeProcess?.(files.get(file.path));
        if (options.failReference) throw new Error("note write failed");
        const entry = files.get(file.path);
        const next = transform(entry.data);
        if (next !== entry.data) { entry.data = next; actions.push("reference"); }
      },
      trash: async file => {
        if (options.failTrash) throw new Error("trash failed");
        trash.push(files.get(file.path)); files.delete(file.path); actions.push("trash");
      },
    },
    fileManager: { renameFile: async (file, path) => {
      if (options.failRename) throw new Error("rename failed");
      const entry = files.get(file.path); files.delete(file.path);
      file.path = path; files.set(path, entry); actions.push("rename");
    } },
  };
  const settings = {
    attachPath: { saveAttE: "obsFolder", attachFormat: "output", extensionOverride: [] },
    overridePath: {}, dateFormat: "YYYYMMDD", convertTo: "webp", convertImageExtensions: "",
    videoConvertTo: "disabled", ffmpegPath: "", resizeMode: "disabled", resizeValue: 1920,
    quality: 85, trackedFields: ["cover"], pathFormat: "plain", disableNotification: true,
    preserveExif: false, preserveGps: false,
  };
  processor = new AttachmentProcessor({ app, saveSettings: async () => {} }, settings, new Set(), {
    updateNoteIndex: (...args) => indexes.push(args),
  });
  return { processor, source, image, files, trash, actions, queue, settings, indexes };
}

test.beforeEach(t => {
  t.mock.method(console, "error", () => {});
  convert = async () => ({ data: converted, ext: "webp" });
  metadata = async (_source, _ext, output) => output;
});

test("conversion commits a separate output and link before trashing the intact original", async () => {
  const f = fixture();
  const output = await f.processor.processNewAttach(f.image, f.source);
  assert.deepEqual(f.actions, ["create", "reference", "trash"]);
  assert.equal(output.path, "attachments/output.webp");
  assert.equal(f.trash[0].data, original);
  assert.equal(f.files.get(output.path).data, converted);
  assert.match(f.files.get(f.source.path).data, /!\[\[output.webp\|500\]\]/);
  assert.deepEqual(f.queue, [], "generated outputs must not be converted recursively");
});

test("output creation failure preserves original data and the source link", async () => {
  const f = fixture({ failCreate: true });
  await f.processor.processNewAttach(f.image, f.source);
  assert.equal(f.files.get(f.image.path).data, original);
  assert.match(f.files.get(f.source.path).data, /source.png/);
  assert.deepEqual(f.trash, []);
  assert.equal(f.processor.consumeCreated("attachments/output.webp"), false);
});

test("reference write failure keeps both files and the original link", async () => {
  const f = fixture({ failReference: true });
  await f.processor.processNewAttach(f.image, f.source);
  assert.equal(f.files.get(f.image.path).data, original);
  assert.ok(f.files.has("attachments/output.webp"));
  assert.match(f.files.get(f.source.path).data, /source.png/);
  assert.deepEqual(f.trash, []);
});

test("a corrupted output never replaces the source reference or original", async () => {
  const f = fixture({ corruptOutput: true });
  await f.processor.processNewAttach(f.image, f.source);
  assert.deepEqual(f.actions, ["create"]);
  assert.equal(f.files.get(f.image.path).data, original);
  assert.match(f.files.get(f.source.path).data, /source.png/);
});

test("trash failure leaves a valid converted link and both copies", async () => {
  const f = fixture({ failTrash: true });
  await f.processor.processNewAttach(f.image, f.source);
  assert.equal(f.files.get(f.image.path).data, original);
  assert.match(f.files.get(f.source.path).data, /output.webp/);
  assert.ok(f.files.has("attachments/output.webp"));
});

test("other notes referencing the original keep their original file available", async () => {
  const f = fixture({ otherReferences: true });
  await f.processor.processNewAttach(f.image, f.source);
  assert.ok(f.files.has(f.image.path));
  assert.deepEqual(f.trash, []);
});

test("atomic link update preserves concurrent prose and nested YAML", async () => {
  const f = fixture({
    content: '---\ncover: "![[source.png]]"\nmetadata:\n  cover: nested.jpg\n---\n![](../attachments/source.png)',
    beforeProcess: entry => { entry.data += "\nnew prose"; },
  });
  await f.processor.processNewAttach(f.image, f.source);
  const content = f.files.get(f.source.path).data;
  const fm = yaml.load(content.split("---")[1]);
  assert.equal(fm.cover, "../attachments/output.webp");
  assert.equal(fm.metadata.cover, "nested.jpg");
  assert.match(content, /new prose/);
  assert.match(content, /!\[\]\(\.\.\/attachments\/output.webp\)/);
  assert.equal(f.indexes.at(-1)[1].get("cover"), "attachments/output.webp");
});

test("dispose while conversion runs prevents any subsequent file write", async () => {
  let finish;
  convert = () => new Promise(resolve => { finish = resolve; });
  const f = fixture();
  const task = f.processor.processNewAttach(f.image, f.source);
  await new Promise(resolve => setImmediate(resolve));
  f.processor.dispose();
  finish({ data: converted, ext: "webp" });
  await task;
  assert.deepEqual(f.actions, []);
  assert.equal(f.files.get(f.image.path).data, original);
});

test("dispose after output creation keeps original and skips reference/trash", async () => {
  const f = fixture({ afterCreate: processor => processor.dispose() });
  await f.processor.processNewAttach(f.image, f.source);
  assert.deepEqual(f.actions, ["create"]);
  assert.equal(f.files.get(f.image.path).data, original);
});

test("same-format input still receives requested resize and quality settings", async () => {
  const calls = [];
  convert = async (...args) => { calls.push(args); return { data: converted, ext: "webp" }; };
  const f = fixture();
  f.settings.resizeMode = "width";
  await f.processor._convertImageData({ path: f.image.path, extension: "webp" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][3], { mode: "width", value: 1920 });
  assert.equal(calls[0][2], 85);
});

test("metadata failure leaves the original untouched", async () => {
  metadata = async () => { throw new Error("metadata copy failed"); };
  const f = fixture(); f.settings.preserveExif = true;
  await f.processor.processNewAttach(f.image, f.source);
  assert.deepEqual(f.actions, []);
  assert.equal(f.files.get(f.image.path).data, original);
});

test("rename-only failure does not overwrite image data", async () => {
  const f = fixture({ failRename: true }); f.settings.convertTo = "disabled";
  await f.processor.processNewAttach(f.image, f.source);
  assert.equal(f.files.get(f.image.path).data, original);
  assert.deepEqual(f.actions, []);
});

test("canvas file nodes are updated without adding YAML or breaking JSON", async () => {
  const f = fixture();
  f.files.delete(f.source.path); f.source.path = "notes/test.canvas";
  f.files.set(f.source.path, { file: f.source, data: JSON.stringify({ nodes: [{ type: "file", file: f.image.path }], edges: [] }) });
  await f.processor.processNewAttach(f.image, f.source);
  const canvas = JSON.parse(f.files.get(f.source.path).data);
  assert.equal(canvas.nodes[0].file, "attachments/output.webp");
  assert.equal(f.trash.length, 1);
});
