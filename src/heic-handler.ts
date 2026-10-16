/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
/**
 * HEIC/HEIF decoder using macOS ImageIO, with heic2any as a portable fallback.
 * Converts static HEIC images to PNG for further Canvas API processing.
 */

import heic2any from "heic2any";
import { Platform } from "obsidian";
import { execFile } from "child_process";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function decodeHeic(data: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (Platform.isDesktopApp && Platform.isMacOS) {
    try {
      const dir = await mkdtemp(join(tmpdir(), "attachhub-heic-"));
      try {
        const input = join(dir, "input.heic");
        const output = join(dir, "output.png");
        await writeFile(input, new Uint8Array(data));
        // ImageIO supports newer iPhone HEIC files that heic2any cannot decode.
        await execFileAsync("/usr/bin/sips", ["-s", "format", "png", input, "--out", output], { timeout: 30_000 });
        const png = await readFile(output);
        return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn("[AttachHub] macOS HEIC decode failed, trying heic2any:", e);
    }
  }
  try {
    const blob = new Blob([data], { type: "image/heic" });
    const result = await heic2any({ blob, toType: "image/png", multiple: false });
    const outBlob = Array.isArray(result) ? result[0] : result;
    if (!(outBlob instanceof Blob)) return null;
    return await outBlob.arrayBuffer();
  } catch (e) {
    console.error("[AttachHub] HEIC decode failed:", e);
    return null;
  }
}
