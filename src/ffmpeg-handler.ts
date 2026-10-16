/* eslint-disable no-undef, no-empty */
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

let exiftoolAvailable: boolean | null = null;
let exiftoolPath: string | null = null;

async function hasExiftool(): Promise<boolean> {
  if (exiftoolAvailable !== null) return exiftoolAvailable;
  // Preferred: use bundled executable copied to plugin directory.
  try {
    const bundled = path.join(__dirname, "vendor", "exiftool");
    await execFileAsync(bundled, ["-ver"], { timeout: 5000 });
    exiftoolPath = bundled;
    exiftoolAvailable = true;
    return true;
  } catch {
    // continue
  }
  try {
    exiftoolPath = require.resolve("exiftool-vendored.pl/bin/exiftool");
    await execFileAsync(exiftoolPath, ["-ver"], { timeout: 5000 });
    exiftoolAvailable = true;
    return true;
  } catch {
    // Fallback to system exiftool (PATH/common locations).
    for (const candidate of ["exiftool", "/opt/homebrew/bin/exiftool", "/usr/local/bin/exiftool", "/usr/bin/exiftool"]) {
      try {
        await execFileAsync(candidate, ["-ver"], { timeout: 5000 });
        exiftoolPath = candidate;
        exiftoolAvailable = true;
        return true;
      } catch {
        // try next
      }
    }
    exiftoolAvailable = false;
    return false;
  }
}

async function copyMetadataWithExiftool(inputFile: string, outputFile: string, keepGps: boolean): Promise<void> {
  if (!(await hasExiftool())) throw new Error("ExifTool is unavailable; metadata could not be preserved");
  const args = ["-overwrite_original", "-TagsFromFile", inputFile, "-all:all"];
  if (!keepGps) args.push("-all:GPS*=", "-QuickTime:GPSCoordinates=", "-xmp:geotag=");
  args.push("-P");
  if (!exiftoolPath) throw new Error("ExifTool is unavailable; metadata could not be preserved");
  await execFileAsync(exiftoolPath, [...args, outputFile], { timeout: 20_000 });
}

export type VideoTarget = "webp" | "gif" | "disabled";

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
  preserveExif?: boolean;
  preserveGps?: boolean;
}

function buildFFmpegArgs(
  inFile: string,
  outFile: string,
  opts: ConvertOpts,
): string[] {
  const args = ["-y", "-i", inFile, "-map_metadata", "-1"];
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
    const args = buildFFmpegArgs(absPath, outFile, opts);
    await execFileAsync(opts.ffmpegPath, args, { timeout: 120_000 });
    if (opts.preserveExif) await copyMetadataWithExiftool(absPath, outFile, Boolean(opts.preserveGps));
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

/**
 * Preserve metadata for conversions performed outside FFmpeg (e.g. Canvas).
 * Uses exiftool as a post-process metadata copier from source -> output bytes.
 */
export async function copyMetadataToBuffer(
  sourceData: ArrayBuffer,
  sourceExt: string,
  outputData: ArrayBuffer,
  outputExt: string,
  keepGps: boolean,
): Promise<ArrayBuffer> {
  const tmpDir = await mkdtempAsync(path.join(os.tmpdir(), "attachhub-meta-"));
  const safeSourceExt = (sourceExt || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const srcFile = path.join(tmpDir, `source.${safeSourceExt}`);
  const outFile = path.join(tmpDir, `output.${outputExt}`);
  try {
    await writeFileAsync(srcFile, Buffer.from(sourceData));
    await writeFileAsync(outFile, Buffer.from(outputData));
    await copyMetadataWithExiftool(srcFile, outFile, keepGps);
    const result = await readFileAsync(outFile);
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  } finally {
    try { await unlinkAsync(srcFile); } catch {}
    try { await unlinkAsync(outFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}
