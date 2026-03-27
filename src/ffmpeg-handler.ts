/* eslint-disable import/no-nodejs-modules, no-undef, no-empty */
/**
 * FFmpeg handler using system-installed FFmpeg binary.
 * Supports: animated HEIF → WEBP, MP4/MOV → WEBP/GIF, and general video conversion.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execFileAsync = promisify(execFile);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);
const mkdtempAsync = promisify(fs.mkdtemp);

interface MaybeErrno {
  code?: string;
  message?: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as MaybeErrno).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
}

export type VideoTarget = "webp" | "gif" | "disabled";

export const VIDEO_EXT = new Set(["mp4", "mov", "avi", "mkv", "webm"]);

export function isVideoExt(ext: string): boolean {
  return VIDEO_EXT.has(ext.toLowerCase());
}

/**
 * Detect whether a HEIC/HEIF file contains animation (Live Photo / image sequence).
 * Checks for moov atom or sequence-related ftyp brands.
 * Static HEIC returns false → should use image processor instead of FFmpeg.
 */
export async function isAnimatedHeic(absPath: string): Promise<boolean> {
  const fd = await new Promise<number>((resolve, reject) =>
    fs.open(absPath, "r", (err, fd) => (err ? reject(err) : resolve(fd))),
  );
  try {
    const headerBuf = Buffer.alloc(4096);
    const bytesRead: number = await new Promise((resolve, reject) =>
      fs.read(fd, headerBuf, 0, 4096, 0, (err, n) => (err ? reject(err) : resolve(n))),
    );
    const data = headerBuf.subarray(0, bytesRead);

    // Check ftyp compatible brands for sequence indicators
    if (data.length >= 8) {
      const ftypStart = data.indexOf("ftyp");
      if (ftypStart >= 0 && ftypStart >= 4) {
        const boxSizeOffset = ftypStart - 4;
        const boxSize = data.readUInt32BE(boxSizeOffset);
        const brandEnd = Math.min(boxSizeOffset + boxSize, data.length);
        const brandSection = data.subarray(ftypStart + 4, brandEnd).toString("ascii");
        const seqBrands = ["avis", "msf1", "mif2"];
        for (const sb of seqBrands) {
          if (brandSection.includes(sb)) return true;
        }
      }
    }

    // Scan for 'moov' atom — presence indicates video/animation tracks
    const moovSig = Buffer.from("moov");
    if (data.indexOf(moovSig) >= 0) return true;

    // Also scan a larger portion for moov if file is big
    const statSize: number = await new Promise((resolve, reject) =>
      fs.fstat(fd, (err, st) => (err ? reject(err) : resolve(st.size))),
    );
    if (statSize > 4096) {
      const scanSize = Math.min(65536, statSize);
      const bigBuf = Buffer.alloc(scanSize);
      await new Promise<number>((resolve, reject) =>
        fs.read(fd, bigBuf, 0, scanSize, 0, (err, n) => (err ? reject(err) : resolve(n))),
      );
      if (bigBuf.indexOf(moovSig) >= 0) return true;
    }

    return false;
  } finally {
    fs.closeSync(fd);
  }
}

export async function testFFmpeg(ffmpegPath: string): Promise<string> {
  if (!ffmpegPath) throw new Error("FFmpeg path is empty");
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegPath, ["-version"], { timeout: 5000 });
    const output = stdout || stderr;
    const firstLine = output.split("\n")[0]?.trim();
    if (!firstLine) throw new Error("No output from ffmpeg");
    return firstLine;
  } catch (e: unknown) {
    const code = typeof e === "object" && e !== null ? (e as MaybeErrno).code : undefined;
    if (code === "ENOENT") throw new Error(`File not found: ${ffmpegPath}`);
    if (code === "EACCES") throw new Error(`Permission denied: ${ffmpegPath}`);
    throw new Error(errorMessage(e));
  }
}

interface ConvertOpts {
  ffmpegPath: string;
  target: VideoTarget;
  quality: number;       // 1-100
  resizeValue?: number;  // max dimension (0 = no resize)
}

export async function convertVideo(
  inputData: ArrayBuffer,
  inputExt: string,
  opts: ConvertOpts,
): Promise<{ data: ArrayBuffer; ext: string } | null> {
  if (opts.target === "disabled" || !opts.ffmpegPath) return null;

  const tmpDir = await mkdtempAsync(path.join(os.tmpdir(), "attachhub-"));
  const inFile = path.join(tmpDir, `input.${inputExt}`);
  const outExt = opts.target;
  const outFile = path.join(tmpDir, `output.${outExt}`);

  try {
    await writeFileAsync(inFile, Buffer.from(inputData));

    const args = buildFFmpegArgs(inFile, outFile, inputExt, opts);
    await execFileAsync(opts.ffmpegPath, args, { timeout: 120_000 });

    const result = await readFileAsync(outFile);
    return { data: result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength), ext: outExt };
  } catch (e: unknown) {
    console.error("[AttachHub] FFmpeg conversion failed:", errorMessage(e));
    return null;
  } finally {
    try { await unlinkAsync(inFile); } catch {}
    try { await unlinkAsync(outFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

function buildFFmpegArgs(
  inFile: string,
  outFile: string,
  inputExt: string,
  opts: ConvertOpts,
): string[] {
  const args = ["-y", "-i", inFile];
  const q = Math.max(1, Math.min(100, opts.quality));

  if (opts.target === "webp") {
    args.push("-vcodec", "libwebp");
    args.push("-lossless", "0");
    // libwebp quality: 0-100 (higher = better)
    args.push("-q:v", String(q));
    args.push("-loop", "0");
    args.push("-an"); // strip audio for animated webp
    if (opts.resizeValue && opts.resizeValue > 0) {
      args.push("-vf", `scale='min(${opts.resizeValue},iw)':'min(${opts.resizeValue},ih)':force_original_aspect_ratio=decrease`);
    }
  } else if (opts.target === "gif") {
    const filters: string[] = [];
    if (opts.resizeValue && opts.resizeValue > 0) {
      filters.push(`scale='min(${opts.resizeValue},iw)':'min(${opts.resizeValue},ih)':force_original_aspect_ratio=decrease:flags=lanczos`);
    }
    filters.push("split[s0][s1]");
    filters.push("[s0]palettegen=max_colors=256[p]");
    filters.push("[s1][p]paletteuse=dither=bayer:bayer_scale=5");
    args.push("-filter_complex", filters.join(","));
    args.push("-loop", "0");
  }

  args.push(outFile);
  return args;
}

export interface StillConvertOpts {
  ffmpegPath: string;
  targetExt: string;   // "webp" | "jpg" | "png"
  quality: number;
  resizeValue?: number;
}

/**
 * Convert a still image (e.g. HEIC) to a standard format using FFmpeg.
 * Extracts a single frame — no animation, no loop.
 */
export async function convertImageWithFFmpeg(
  absPath: string,
  opts: StillConvertOpts,
): Promise<{ data: ArrayBuffer; ext: string } | null> {
  if (!opts.ffmpegPath) return null;

  const tmpDir = await mkdtempAsync(path.join(os.tmpdir(), "attachhub-"));
  const outExt = opts.targetExt;
  const outFile = path.join(tmpDir, `output.${outExt}`);

  try {
    const args = ["-y", "-i", absPath, "-frames:v", "1"];
    const q = Math.max(1, Math.min(100, opts.quality));

    if (outExt === "webp") {
      args.push("-vcodec", "libwebp", "-lossless", "0", "-q:v", String(q));
    } else if (outExt === "jpg") {
      args.push("-q:v", String(Math.round(31 - (q / 100) * 29)));
    }
    // png needs no quality flag

    if (opts.resizeValue && opts.resizeValue > 0) {
      args.push("-vf", `scale='min(${opts.resizeValue},iw)':'min(${opts.resizeValue},ih)':force_original_aspect_ratio=decrease`);
    }

    args.push(outFile);
    await execFileAsync(opts.ffmpegPath, args, { timeout: 30_000 });
    const result = await readFileAsync(outFile);
    return { data: result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength), ext: outExt };
  } catch (e: unknown) {
    console.error("[AttachHub] FFmpeg image conversion failed:", errorMessage(e));
    return null;
  } finally {
    try { await unlinkAsync(outFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

/**
 * Convert a video file that already exists on disk (by vault absolute path).
 * Returns the converted data + new extension, or null if conversion not needed/failed.
 */
export async function convertVideoFile(
  absPath: string,
  inputExt: string,
  opts: ConvertOpts,
): Promise<{ data: ArrayBuffer; ext: string } | null> {
  if (opts.target === "disabled" || !opts.ffmpegPath) return null;

  const tmpDir = await mkdtempAsync(path.join(os.tmpdir(), "attachhub-"));
  const outExt = opts.target;
  const outFile = path.join(tmpDir, `output.${outExt}`);

  try {
    const args = buildFFmpegArgs(absPath, outFile, inputExt, opts);
    await execFileAsync(opts.ffmpegPath, args, { timeout: 120_000 });
    const result = await readFileAsync(outFile);
    return { data: result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength), ext: outExt };
  } catch (e: unknown) {
    console.error("[AttachHub] FFmpeg file conversion failed:", errorMessage(e));
    return null;
  } finally {
    try { await unlinkAsync(outFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}
