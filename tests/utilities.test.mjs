import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
const obsidian = {
  parseYaml: text => yaml.load(text),
  stringifyYaml: value => yaml.dump(value, { noRefs: true, lineWidth: -1 }),
  normalizePath: path => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
};

async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
    external: ["obsidian"],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(
    id => id === "obsidian" ? obsidian : require(id), module, module.exports,
  );
  return module.exports;
}

const fm = await load("src/frontmatter-utils.ts");
const files = await load("src/file-utils.ts");

test("YAML parser keeps nested metadata.cover separate from top-level cover", () => {
  const parsed = fm.parseFM("---\nmetadata:\n  cover: nested.jpg\ncover: top.jpg\n---\nbody");
  assert.equal(parsed.cover, "top.jpg");
  assert.equal(parsed.metadata.cover, "nested.jpg");
  assert.equal(fm.parseFM("---\n- item\n---\n"), null);
});

test("frontmatter replacement round-trips Markdown and wikilink strings", () => {
  const values = ["![](folder/a#b.jpg)", "[[folder/a|label]]", "#literal", "has: colon"];
  let content = "---\nmetadata:\n  keep: yes\n---\nbody\n";
  for (const [index, value] of values.entries()) content = fm.replaceFMField(content, `field${index}`, value);
  const parsed = fm.parseFM(content);
  values.forEach((value, index) => assert.equal(parsed[`field${index}`], value));
  assert.equal(parsed.metadata.keep, "yes");
});

test("replacement creates frontmatter and treats dollar sequences literally", () => {
  const value = "$& $$ $` $'";
  const result = fm.replaceFMField("body\r\n", "cover", value);
  assert.equal(fm.parseFM(result).cover, value);
  assert.match(result, /\r\n/);
  assert.deepEqual(fm.parseFM("---\n---\nbody"), {});
  assert.equal(fm.parseFM(fm.replaceFMField("---\n---\nbody", "cover", "image.webp")).cover, "image.webp");
});

test("writeFM processes the latest content atomically and respects canWrite", async t => {
  t.mock.method(console, "error", () => {});
  let latest = "---\ntitle: initial\n---\nbody";
  const app = {
    vault: {
      read: async () => "stale", // writeFM must not use this as its update source.
      process: async (_file, callback) => { latest = callback(latest); },
    },
    metadataCache: { getFileCache: () => null },
  };
  assert.equal(await fm.writeFM(app, { path: "note.md" }, { cover: "[[image.jpg]]" }), true);
  assert.equal(fm.parseFM(latest).title, "initial");
  assert.equal(fm.parseFM(latest).cover, "[[image.jpg]]");
  const unchanged = latest;
  assert.equal(await fm.writeFM(app, { path: "note.md" }, { title: "blocked" }, () => false), false);
  assert.equal(latest, unchanged);
  let checks = 0;
  assert.equal(await fm.writeFM(app, { path: "note.md" }, { title: "blocked" }, () => ++checks < 2), false);
  assert.equal(latest, unchanged);
});

test("MD5 reads current bytes each time and returns the standard known vector", async () => {
  let bytes = new TextEncoder().encode("abc").buffer;
  const adapter = { readBinary: async () => bytes };
  const file = { path: "image.bin" };
  assert.equal(await files.md5sum(adapter, file), "900150983CD24FB0D6963F7D28E17F72");
  bytes = new TextEncoder().encode("changed").buffer;
  assert.equal(await files.md5sum(adapter, file), "8977DFAC2F8E04CB96E66882235F5ABA");
});

test("dedup checks current targets, permits the source path, and supports large suffixes", async () => {
  const present = new Set();
  const adapter = { exists: async path => present.has(path) };
  assert.equal(await files.dedup("image.png", "attachments", adapter), "image.png");
  present.add("attachments/image.png");
  assert.equal(await files.dedup("image.png", "attachments", adapter), "image-1.png");
  assert.equal(await files.dedup("image.png", "attachments", adapter, "attachments/image.png"), "image.png");
  for (let i = 1; i <= 1000; i++) present.add(`attachments/image-${i}.png`);
  assert.equal(await files.dedup("image.png", "attachments", adapter), "image-1001.png");
  await assert.rejects(files.dedup("image.png", "attachments", { exists: async () => { throw new Error("I/O failed"); } }), /I\/O failed/);
});
