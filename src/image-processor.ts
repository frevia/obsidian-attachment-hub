/**
 * Image processing via Canvas API.
 * Handles conversion between JPG/PNG/WEBP/GIF/BMP and quality compression.
 * Phase 2 implementation.
 */

export type ImageFormat = "webp" | "jpg" | "png" | "disabled";

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
  try {
    const [w, h] = computeSize(bitmap.width, bitmap.height, resize);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建图片画布");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const mime = MIME_MAP[targetFormat];
    const outBlob = await canvas.convertToBlob({ type: mime, quality: Math.max(1, Math.min(100, quality)) / 100 });
    if (outBlob.type !== mime) throw new Error(`不支持目标图片格式：${targetFormat}`);
    return { data: await outBlob.arrayBuffer(), ext: targetFormat };
  } finally {
    bitmap.close();
  }
}
