import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
globalThis.window = {};
const obsidian = { normalizePath: path => path.replace(/\\/g, "/").replace(/\/+/g, "/") };
const { outputFiles } = await build({
  entryPoints: ["src/utils.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(id => id === "obsidian" ? obsidian : require(id), module, module.exports);
const { resolveVars, computeAttachPath, computeAttachName } = module.exports;

test("filename prefix defaults to empty and works with templates and original names", async () => {
  window.moment = () => ({ format: () => "20261019" });
  const name = (format, prefix, path = "attachments/cover.heic") => computeAttachName(
    { path: "notes/draft.md" }, path ? { path } : null,
    { attachFormat: format, extensionOverride: [] }, "YYYYMMDD", {}, undefined, prefix,
  );
  assert.equal(await name("img-${date}"), "img-20261019");
  assert.equal(await name("${originalname}", "photo-"), "photo-cover");
  assert.equal(await name("${originalname}", "photo-", "attachments/photo-cover.webp"), "photo-cover");
  assert.equal(await name("${notename}-${date}", "旅行_"), "旅行_draft-20261019");
  assert.equal(await name("img-${date}", "img-"), "img-20261019");
  assert.equal(await name("${originalname}", "photo-", null), "photo-clipboard");
  assert.equal(await name("${originalname}", ""), "cover");
  assert.equal(await name("${originalname}", "  "), "cover");
  assert.equal(await name("${originalname}", "trip/\\:*?<>|\"\n-"), "trip__________-cover");
});
