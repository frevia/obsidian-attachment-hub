import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({ entryPoints: ["src/image-processor.ts"], bundle: true, write: false, format: "cjs" });
const module = { exports: {} };
new Function("module", "exports", outputFiles[0].text)(module, module.exports);
const { convertImage } = module.exports;
let closed, frames, outputType, drawFails;

test.beforeEach(() => {
  closed = 0; frames = []; outputType = null; drawFails = false;
  globalThis.createImageBitmap = async () => ({ width: 200, height: 100, close() { closed++; } });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() { if (drawFails) throw Error("draw failed"); } }; }
    async convertToBlob(options) {
      frames.push({ width: this.width, height: this.height, options });
      return new Blob([new Uint8Array([1])], { type: outputType || options.type });
    }
  };
});

test("Canvas applies each resize mode and the configured encoding quality", async () => {
  for (const [mode, size] of [["disabled", [200, 100]], ["width", [75, 38]], ["height", [150, 75]], ["longest", [75, 38]], ["shortest", [150, 75]]]) {
    const result = await convertImage(new ArrayBuffer(0), "webp", 85, { mode, value: 75 });
    const frame = frames.at(-1);
    assert.deepEqual([frame.width, frame.height], size);
    assert.deepEqual(frame.options, { type: "image/webp", quality: 0.85 });
    assert.equal(result.ext, "webp");
  }
  assert.equal(closed, 5);
});

test("an unsupported encoder fallback is rejected and closes the bitmap", async () => {
  outputType = "image/png";
  await assert.rejects(convertImage(new ArrayBuffer(0), "webp", 85, { mode: "disabled", value: 0 }), /不支持目标/);
  assert.equal(closed, 1);
});

test("drawing errors still release the decoded bitmap", async () => {
  drawFails = true;
  await assert.rejects(convertImage(new ArrayBuffer(0), "webp", 85, { mode: "disabled", value: 0 }), /draw failed/);
  assert.equal(closed, 1);
});
