/**
 * Image processing via Canvas API.
 * Handles conversion between JPG/PNG/WEBP/GIF/BMP and quality compression.
 * Phase 2 implementation.
 */

export type ImageFormat = "webp" | "jpg" | "png" | "disabled";

const MAGIC: [string, Uint8Array][] = [
  ["jpg", new Uint8Array([0xff, 0xd8, 0xff])],
  ["png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
  ["gif", new Uint8Array([0x47, 0x49, 0x46])],
  ["webp", new Uint8Array([0x52, 0x49, 0x46, 0x46])], // RIFF header; bytes 8-11 = WEBP
  ["bmp", new Uint8Array([0x42, 0x4d])],
];

export function detectFormat(data: ArrayBuffer): string | null {
  const view = new Uint8Array(data, 0, Math.min(24, data.byteLength));
  for (const [fmt, sig] of MAGIC) {
    if (view.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (view[i] !== sig[i]) { match = false; break; }
    }
    if (match) {
      if (fmt === "webp") {
        if (view.length >= 12 && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) return "webp";
        return null;
      }
      return fmt;
    }
  }
  // HEIC/HEIF: ftyp box at offset 4
  if (view.length >= 12) {
    const ftyp = String.fromCharCode(view[4], view[5], view[6], view[7]);
    if (ftyp === "ftyp") {
      const brand = String.fromCharCode(view[8], view[9], view[10], view[11]);
      if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1"].includes(brand)) return "heic";
    }
  }
  // TIFF
  if (view.length >= 4) {
    if ((view[0] === 0x49 && view[1] === 0x49 && view[2] === 0x2a && view[3] === 0x00) ||
        (view[0] === 0x4d && view[1] === 0x4d && view[2] === 0x00 && view[3] === 0x2a)) return "tiff";
  }
  // MP4/MOV: ftyp box at offset 4 with video brands
  if (view.length >= 12) {
    const ftyp = String.fromCharCode(view[4], view[5], view[6], view[7]);
    if (ftyp === "ftyp") {
      const brand = String.fromCharCode(view[8], view[9], view[10], view[11]);
      const mp4Brands = ["isom", "iso2", "iso3", "iso4", "iso5", "iso6",
        "mp41", "mp42", "avc1", "dash", "M4V ", "M4A "];
      if (mp4Brands.includes(brand)) return "mp4";
      if (brand === "qt  ") return "mov";
    }
  }
  return null;
}

export interface ResizeOpts {
  mode: "disabled" | "width" | "height" | "longest" | "shortest";
  value: number;
}

function computeSize(w: number, h: number, opts: ResizeOpts): [number, number] {
  if (opts.mode === "disabled" || !opts.value) return [w, h];
  const v = opts.value;
  let nw = w, nh = h;
  switch (opts.mode) {
    case "width":
      if (w > v) { nw = v; nh = Math.round(h * (v / w)); }
      break;
    case "height":
      if (h > v) { nh = v; nw = Math.round(w * (v / h)); }
      break;
    case "longest":
      if (Math.max(w, h) > v) {
        if (w >= h) { nw = v; nh = Math.round(h * (v / w)); }
        else { nh = v; nw = Math.round(w * (v / h)); }
      }
      break;
    case "shortest":
      if (Math.min(w, h) > v) {
        if (w <= h) { nw = v; nh = Math.round(h * (v / w)); }
        else { nh = v; nw = Math.round(w * (v / h)); }
      }
      break;
  }
  return [Math.max(1, nw), Math.max(1, nh)];
}

const MIME_MAP: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
};

export async function convertImage(
  data: ArrayBuffer,
  targetFormat: ImageFormat,
  quality: number,
  resize: ResizeOpts,
): Promise<{ data: ArrayBuffer; ext: string } | null> {
  if (targetFormat === "disabled") return null;

  const blob = new Blob([data]);
  const bitmap = await createImageBitmap(blob);
  const [w, h] = computeSize(bitmap.width, bitmap.height, resize);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const mime = MIME_MAP[targetFormat] || "image/webp";
  const q = quality / 100;
  const outBlob = await canvas.convertToBlob({ type: mime, quality: q });
  const buf = await outBlob.arrayBuffer();
  return { data: buf, ext: targetFormat === "jpg" ? "jpg" : targetFormat };
}
