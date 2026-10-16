import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile, writeFile, access } from "node:fs/promises";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const source = Uint8Array.from([1, 2, 3]).buffer;
const paths = [];
const messages = [];
let portableCalls = 0;
let nativeFails = false;
let portableFails = false;
const platform = { isDesktopApp: true, isMacOS: true };
class TFile {}
const obsidian = {
  Platform: platform, TFile, Plugin: class {},
  Notice: class { constructor(message) { messages.push(message); } },
  normalizePath: path => path.replace(/\/+/g, "/"),
  parseYaml: () => ({}), stringifyYaml: () => "",
};

async function load(entry, replacements = {}) {
  const { outputFiles } = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
    external: ["obsidian", "heic2any"],
    plugins: [{ name: "conversion-seams", setup(builder) {
      builder.onResolve({ filter: /^\.\/(image-processor|ffmpeg-handler)$/ }, args => ({
        path: args.path, external: true,
      }));
    } }],
  });
  const module = { exports: {} };
  const overrides = {
    obsidian,
    heic2any: async () => {
      portableCalls++;
      if (portableFails) throw new Error("unsupported HEIC");
      return new Blob([png]);
    },
    child_process: { execFile(command, args, options, callback) {
      paths.push({ command, args, options });
      if (nativeFails) return callback(new Error("sips failed"));
      readFile(args[3]).then(data => {
        assert.deepEqual([...data], [...new Uint8Array(source)]);
        return writeFile(args[5], png);
      }).then(() => callback(null, "", ""), callback);
    } },
    ...replacements,
  };
  new Function("require", "module", "exports", outputFiles[0].text)(
    id => id in overrides ? overrides[id] : require(id), module, module.exports,
  );
  return module.exports;
}

const { decodeHeic } = await load("src/heic-handler.ts");

test("macOS decodes HEIC via sips and removes its temporary files", async () => {
  const result = await decodeHeic(source);
  assert.deepEqual([...new Uint8Array(result)], [...png]);
  assert.equal(portableCalls, 0);
  const call = paths.at(-1);
  assert.equal(call.command, "/usr/bin/sips");
  assert.equal(call.options.timeout, 30000);
  await assert.rejects(access(call.args[3]), { code: "ENOENT" });
  await assert.rejects(access(call.args[5]), { code: "ENOENT" });
});

test("sips failure cleans up and falls back to heic2any", async () => {
  nativeFails = true;
  try {
    assert.deepEqual([...new Uint8Array(await decodeHeic(source))], [...png]);
    assert.equal(portableCalls, 1);
    await assert.rejects(access(paths.at(-1).args[3]), { code: "ENOENT" });
  } finally { nativeFails = false; }
});

test("other platforms use the portable decoder without invoking sips", async () => {
  platform.isMacOS = false;
  const calls = paths.length;
  try {
    assert.deepEqual([...new Uint8Array(await decodeHeic(source))], [...png]);
    assert.equal(paths.length, calls);
  } finally { platform.isMacOS = true; }
});

test("complete decode failure returns null and cleans up", async () => {
  nativeFails = portableFails = true;
  try {
    assert.equal(await decodeHeic(source), null);
    await assert.rejects(access(paths.at(-1).args[3]), { code: "ENOENT" });
  } finally { nativeFails = portableFails = false; }
});

test("image conversion uses Canvas WebP and copies metadata from the original HEIC", async () => {
  const conversions = [], metadata = [], ffmpeg = [];
  const webp = Uint8Array.from([82, 73, 70, 70]).buffer;
  const { AttachmentProcessor } = await load("src/attachment-processor.ts", {
    "./image-processor": { convertImage: async (...args) => {
      conversions.push(args); return { data: webp, ext: args[1] };
    } },
    "./ffmpeg-handler": {
      copyMetadataToBuffer: async (...args) => { metadata.push(args); return args[2]; },
      isAnimatedHeic: async path => { ffmpeg.push(path); return false; },
      convertVideoFile: async (...args) => { ffmpeg.push(args); return null; },
    },
  });
  const settings = {
    convertTo: "webp", preserveExif: true, preserveGps: false, quality: 85,
    resizeMode: "disabled", resizeValue: 1920, ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    videoConvertTo: "webp",
  };
  const plugin = { app: { vault: {
    adapter: { basePath: "/Users/test/My Vault" }, readBinary: async () => source,
  } } };
  const processor = new AttachmentProcessor(plugin, settings, new Set());
  const file = { name: "photo.heic", extension: "heic", path: "attachments/photo.heic" };
  assert.deepEqual(await processor._convertImageData(file), { data: webp, ext: "webp" });
  assert.deepEqual([...new Uint8Array(conversions[0][0])], [...png]);
  assert.equal(conversions[0][1], "webp");
  assert.deepEqual(metadata[0], [source, "heic", webp, "webp", false]);
  assert.equal(ffmpeg.length, 0);
  await processor._isHeicAnimated(file);
  assert.equal(ffmpeg.pop(), "/Users/test/My Vault/attachments/photo.heic");
  await processor._convertVideoData({ ...file, extension: "mov" });
  assert.equal(ffmpeg.pop()[0], "/Users/test/My Vault/attachments/photo.heic");

  await processor._convertImageData({ name: "photo.png", extension: "png", path: "attachments/photo.png" });
  assert.equal(ffmpeg.length, 0, "static images must not invoke FFmpeg");
  assert.equal(conversions.length, 2);

  nativeFails = portableFails = true;
  try {
    assert.equal(await processor._convertImageData(file), null);
    assert.match(messages.at(-1), /HEIC 转换失败，已保留原图/);
  } finally { nativeFails = portableFails = false; }
});
