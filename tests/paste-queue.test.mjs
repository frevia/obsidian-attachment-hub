import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").at(-1);
    this.extension = this.name.split(".").at(-1);
    this.stat = { ctime: Date.now() };
  }
}
const obsidian = {
  TFile, TFolder: class {}, Plugin: class {}, Modal: class {}, SuggestModal: class {},
  normalizePath: path => path.replace(/\/+/g, "/"),
};
const { outputFiles } = await build({
  entryPoints: ["src/event-handlers.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(
  id => id === "obsidian" ? obsidian : require(id), module, module.exports,
);
const { EventHandlers } = module.exports;
const image = name => new TFile(`attachments/${name}.heic`);
const note = new TFile("notes/test.md");
const embeds = files => files.map(f => `![[${f.name}]]`).join("\n");

function fixture(files, content = embeds(files), process = async () => {}) {
  const queue = [...files], processed = [], writing = new Set(), callbacks = new Map();
  const contents = new Map([[note.path, content]]);
  const missing = new Set();
  let active = 0, maximumActive = 0;
  const plugin = {
    settings: { excludeExtensionPattern: "" }, registerEvent() {},
    app: {
      vault: {
        on(event, callback) { callbacks.set(event, callback); return {}; },
        adapter: { exists: async path => !missing.has(path), read: async path => contents.get(path) },
      },
      metadataCache: { on: () => ({}) }, workspace: { on: () => ({}) },
      fileManager: { generateMarkdownLink: f => `![[${f.name}]]` },
    },
  };
  const processor = { consumeCreated: () => false, async processNewAttach(file, source) {
    active++;
    maximumActive = Math.max(maximumActive, active);
    processed.push([file.name, source.path]);
    try { await process(file, source); } finally { active--; }
  } };
  const handler = new EventHandlers(plugin, plugin.settings, processor, {}, {}, queue, writing, {});
  return { handler, queue, contents, processed, writing, missing, callbacks,
    maximumActive: () => maximumActive };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("one paste detection processes every linked image in the batch", async () => {
  const files = [image("first"), image("second"), image("third")];
  const f = fixture(files);
  await f.handler._handlePasteDetect(note);
  assert.deepEqual(f.processed.map(x => x[0]), files.map(x => x.name));
  assert.deepEqual(f.queue, []);
});

test("multiple file creations followed by one note modification process the full paste", async () => {
  const files = [image("first"), image("second"), image("third")];
  const f = fixture([], embeds(files));
  f.handler.registerEvents();
  for (const file of files) f.callbacks.get("create")(file);
  f.callbacks.get("modify")(note);
  await wait(350);
  assert.deepEqual(f.processed.map(x => x[0]), files.map(x => x.name));
  assert.deepEqual(f.queue, []);
});

test("internally generated outputs never enter the automatic conversion queue", () => {
  const file = image("generated");
  const f = fixture([]);
  f.handler.attachmentProcessor.consumeCreated = path => path === file.path;
  f.handler.registerEvents();
  f.callbacks.get("create")(file);
  assert.deepEqual(f.queue, []);
});

test("an unrelated note modification in the debounce window does not lose the pasted image", async () => {
  const pasted = image("pasted"), otherNote = new TFile("notes/other.md");
  const f = fixture([]);
  f.contents.set(note.path, embeds([pasted]));
  f.handler.registerEvents();
  f.callbacks.get("create")(pasted);
  f.callbacks.get("modify")(note);
  f.callbacks.get("modify")(otherNote);
  await wait(350);
  assert.deepEqual(f.processed, [[pasted.name, note.path]]);
  assert.deepEqual(f.queue, []);
});

test("two notes each process their own multi-image paste", async () => {
  const first = [image("first-a"), image("first-b")];
  const second = [image("second-a"), image("second-b")];
  const otherNote = new TFile("notes/other.md");
  const files = [...first, ...second];
  const f = fixture([], "");
  f.contents.set(note.path, embeds(first));
  f.contents.set(otherNote.path, embeds(second));
  f.handler.registerEvents();
  for (const file of files) f.callbacks.get("create")(file);
  f.callbacks.get("modify")(note);
  f.callbacks.get("modify")(otherNote);
  await wait(350);
  assert.deepEqual(f.processed, [
    ...first.map(file => [file.name, note.path]),
    ...second.map(file => [file.name, otherNote.path]),
  ]);
  assert.deepEqual(f.queue, []);
});

test("an unrelated queue entry does not block the pasted images", async () => {
  const unrelated = image("unrelated"), pasted = image("pasted");
  const f = fixture([unrelated, pasted], embeds([pasted]));
  await f.handler._handlePasteDetect(note);
  assert.deepEqual(f.processed, [[pasted.name, note.path]]);
  assert.deepEqual(f.queue, [unrelated]);
});

test("deleted queue entries are removed without skipping the following image", async () => {
  const files = [image("deleted"), image("present")];
  const f = fixture(files);
  f.missing.add(files[0].path);
  await f.handler._handlePasteDetect(note);
  assert.deepEqual(f.processed, [[files[1].name, note.path]]);
  assert.deepEqual(f.queue, []);
});

test("overlapping detection requests process each image once, in sequence", async () => {
  const files = [image("first"), image("second"), image("third")];
  const f = fixture(files, embeds(files), () => new Promise(resolve => setTimeout(resolve, 2)));
  await Promise.all([f.handler._handlePasteDetect(note), f.handler._handlePasteDetect(note)]);
  assert.deepEqual(f.processed.map(x => x[0]), files.map(x => x.name));
  assert.equal(f.maximumActive(), 1);
  assert.deepEqual(f.queue, []);
});

test("failure on one image does not abort the remainder of the batch", async t => {
  t.mock.method(console, "error", () => {});
  const files = [image("broken"), image("valid")];
  const f = fixture(files, embeds(files), async file => {
    if (file === files[0]) throw new Error("conversion failed");
  });
  await f.handler._handlePasteDetect(note);
  assert.deepEqual(f.processed.map(x => x[0]), files.map(x => x.name));
  assert.deepEqual(f.queue, []);
});

test("detection requests from different notes keep the correct attachment owner", async () => {
  const first = image("first"), second = image("second"), otherNote = new TFile("notes/other.md");
  const f = fixture([first, second], embeds([second]));
  f.contents.set(otherNote.path, embeds([first]));
  await Promise.all([f.handler._handlePasteDetect(note), f.handler._handlePasteDetect(otherNote)]);
  assert.deepEqual(f.processed, [[second.name, note.path], [first.name, otherNote.path]]);
  assert.deepEqual(f.queue, []);
});

test("images arriving while the plugin patches a note still trigger detection", async () => {
  const first = image("first"), late = image("late");
  const f = fixture([first], embeds([first]), async file => {
    if (file !== first) return;
    f.queue.push(late);
    f.contents.set(note.path, embeds([first, late]));
    f.writing.add(note.path);
    f.callbacks.get("modify")(note);
    f.writing.delete(note.path);
  });
  f.handler.registerEvents();
  await f.handler._handlePasteDetect(note);
  await wait(350);
  assert.deepEqual(f.processed.map(x => x[0]), [first.name, late.name]);
  assert.deepEqual(f.queue, []);
});

test("dispose before the debounce fires cancels pending paste detection", async () => {
  const file = image("pending");
  const f = fixture([]);
  f.contents.set(note.path, embeds([file]));
  f.handler.registerEvents();
  f.callbacks.get("create")(file);
  f.callbacks.get("modify")(note);
  f.handler.dispose();
  await wait(350);
  assert.deepEqual(f.processed, []);
  assert.deepEqual(f.queue, [file]);
});

test("dispose prevents a queued paste task from starting", async () => {
  const files = [image("first"), image("queued")];
  let enterFirst;
  let releaseFirst;
  const firstStarted = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const f = fixture(files, embeds(files), async file => {
    if (file === files[0]) {
      enterFirst();
      await firstGate;
    }
  });
  const firstTask = f.handler._handlePasteDetect(note);
  await firstStarted;
  const queuedTask = f.handler._handlePasteDetect(note);
  f.handler.dispose();
  releaseFirst();
  await Promise.all([firstTask, queuedTask]);
  assert.deepEqual(f.processed, [[files[0].name, note.path]]);
  assert.deepEqual(f.queue, [files[1]]);
});

test("dispose during the first image prevents processing the rest of the batch", async () => {
  const files = [image("first"), image("second")];
  let enterFirst;
  let releaseFirst;
  const firstStarted = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const f = fixture(files, embeds(files), async file => {
    if (file === files[0]) {
      enterFirst();
      await firstGate;
    }
  });
  const task = f.handler._handlePasteDetect(note);
  await firstStarted;
  f.handler.dispose();
  releaseFirst();
  await task;
  assert.deepEqual(f.processed, [[files[0].name, note.path]]);
  assert.deepEqual(f.queue, [files[1]]);
});
