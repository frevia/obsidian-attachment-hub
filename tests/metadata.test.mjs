import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const exiftool = require.resolve("exiftool-vendored.pl/bin/exiftool");
const exiftoolBinDir = path.dirname(exiftool);
const { outputFiles } = await build({
  entryPoints: ["src/ffmpeg-handler.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["child_process"],
});
const moduleSource = outputFiles[0].text;

function pngChunk(name, data) {
  const typeAndData = Buffer.concat([Buffer.from(name), data]);
  let crc = 0xffffffff;
  for (const byte of typeAndData) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc, data.length + 8);
  return chunk;
}

function onePixelPng() {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const pixel = Buffer.from([0, 255, 0, 0, 255]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixel)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function loadHandler(pluginDir, execFileImpl = execFile, resolveImpl = require.resolve) {
  const module = { exports: {} };
  const localRequire = id => id === "child_process" ? { execFile: execFileImpl } : require(id);
  localRequire.resolve = resolveImpl;
  new Function("require", "module", "exports", "__dirname", moduleSource)(
    localRequire, module, module.exports, pluginDir,
  );
  return module.exports;
}

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "attachhub-metadata-test-"));
  try { await callback(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function installVendor(pluginDir) {
  const vendorDir = path.join(pluginDir, "vendor");
  await mkdir(vendorDir, { recursive: true });
  await cp(exiftool, path.join(vendorDir, "exiftool"));
  await cp(path.join(exiftoolBinDir, "lib"), path.join(vendorDir, "lib"), { recursive: true });
  return path.join(vendorDir, "exiftool");
}

async function gpsTags(tool, image) {
  const { stdout } = await execFileAsync(tool, ["-j", "-G1", "-s", "-all:GPS*", "-Make", "-Model", image]);
  return Object.keys(JSON.parse(stdout)[0] || {});
}

function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function taggedImages(tool, source, output) {
  await writeFile(source, onePixelPng());
  await writeFile(output, onePixelPng());
  await execFileAsync(tool, [
    "-overwrite_original", "-GPSLatitude=37.7749", "-GPSLongitude=-122.4194",
    "-XMP-exif:GPSLatitude=37.7749", "-XMP-exif:GPSLongitude=-122.4194",
    "-Make=AttachHubTest", "-Model=MetadataFixture", source,
  ]);
}

test("metadata copy strips EXIF and XMP GPS while preserving camera fields", async () => {
  await withTempDir(async dir => {
    const pluginDir = path.join(dir, "plugin");
    await mkdir(pluginDir);
    const tool = await installVendor(pluginDir);
    await execFileAsync(tool, ["-ver"]);
    const source = path.join(dir, "source.png"), output = path.join(dir, "output.png");
    await taggedImages(tool, source, output);

    const { copyMetadataToBuffer } = loadHandler(pluginDir);
    const result = await copyMetadataToBuffer(arrayBuffer(await readFile(source)), "png", arrayBuffer(await readFile(output)), "png", false);
    await writeFile(output, Buffer.from(result));
    const keys = await gpsTags(tool, output);
    assert.equal(keys.some(key => /GPS/i.test(key)), false);
    assert.ok(keys.some(key => /Make$/.test(key)));
    assert.ok(keys.some(key => /Model$/.test(key)));
  });
});

test("metadata copy keeps EXIF and XMP GPS when requested", async () => {
  await withTempDir(async dir => {
    const pluginDir = path.join(dir, "plugin");
    await mkdir(pluginDir);
    const tool = await installVendor(pluginDir);
    const source = path.join(dir, "source.png"), output = path.join(dir, "output.png");
    await taggedImages(tool, source, output);

    const { copyMetadataToBuffer } = loadHandler(pluginDir);
    const sourceData = await readFile(source), outputData = await readFile(output);
    const result = await copyMetadataToBuffer(
      arrayBuffer(sourceData), "png", arrayBuffer(outputData), "png", true,
    );
    await writeFile(output, Buffer.from(result));
    const keys = await gpsTags(tool, output);
    assert.ok(keys.some(key => /GPS:GPSLatitude/.test(key)), keys.join(", "));
    assert.ok(keys.some(key => /XMP-exif:GPSLatitude/.test(key)), keys.join(", "));
    assert.ok(keys.some(key => /Make$/.test(key)));
    assert.ok(keys.some(key => /Model$/.test(key)));
  });
});

test("missing or failing ExifTool rejects instead of returning unmodified output", async () => {
  const fail = (_command, _args, _options, callback) => callback(new Error("simulated tool failure"));
  const missing = loadHandler("/missing-plugin", fail, () => { throw new Error("module unavailable"); });
  const source = Uint8Array.from([1, 2, 3]).buffer;
  await assert.rejects(missing.copyMetadataToBuffer(source, "png", source, "png", true), /ExifTool is unavailable/);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attachhub-exiftool-fail-"));
  try {
    const pluginDir = path.join(tempDir, "plugin");
    await mkdir(path.join(pluginDir, "vendor"), { recursive: true });
    await writeFile(path.join(pluginDir, "vendor", "exiftool"), "tool");
    const broken = loadHandler(pluginDir, (_command, args, _options, callback) => {
      if (args[0] === "-ver") return callback(null, "13.53", "");
      callback(new Error("simulated metadata copy failure"));
    });
    await assert.rejects(broken.copyMetadataToBuffer(source, "png", source, "png", true), /simulated metadata copy failure/);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

test("FFmpeg conversion disables automatic metadata mapping", async () => {
  await withTempDir(async dir => {
    const input = path.join(dir, "input.mov");
    await writeFile(input, "fixture");
    let argsSeen;
    const fakeFfmpeg = (_command, args, _options, callback) => {
      argsSeen = args;
      writeFile(args.at(-1), onePixelPng()).then(() => callback(null, "", ""), callback);
    };
    const { convertVideoFile } = loadHandler(dir, fakeFfmpeg);
    const result = await convertVideoFile(input, "mov", {
      ffmpegPath: "/test/ffmpeg", target: "webp", quality: 80, preserveExif: false,
    });
    assert.equal(result.ext, "webp");
    assert.equal(argsSeen[argsSeen.indexOf("-map_metadata") + 1], "-1");
  });
});
