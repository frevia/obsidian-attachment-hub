/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * TIFF decoder using UTIF2.
 * Converts TIFF images to RGBA pixel data for Canvas processing.
 * Phase 2 implementation — will be wired in when dependencies are installed.
 */

interface UTIFLibrary {
  decode: (data: ArrayBuffer) => IFD[];
  decodeImage: (data: ArrayBuffer, ifd: IFD) => void;
  toRGBA8: (ifd: IFD) => number[];
}

interface IFD {
  width: number;
  height: number;
}

let UTIF: UTIFLibrary | null = null;

async function loadUTIF(): Promise<UTIFLibrary | null> {
  if (UTIF) return UTIF;
  try {
    const module = await import("utif2");
    UTIF = module as UTIFLibrary;
  } catch {
    console.warn("[AttachHub] utif2 not available");
  }
  return UTIF;
}

export function isTiff(data: ArrayBuffer): boolean {
  const view = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  if (view.length < 4) return false;
  return (
    (view[0] === 0x49 && view[1] === 0x49 && view[2] === 0x2a && view[3] === 0x00) ||
    (view[0] === 0x4d && view[1] === 0x4d && view[2] === 0x00 && view[3] === 0x2a)
  );
}

export async function decodeTiff(data: ArrayBuffer): Promise<ArrayBuffer | null> {
  const lib = await loadUTIF();
  if (!lib) return null;
  try {
    const ifds = lib.decode(data);
    if (!ifds || !ifds.length) return null;
    lib.decodeImage(data, ifds[0]);
    const rgba = lib.toRGBA8(ifds[0]);
    const w = ifds[0].width;
    const h = ifds[0].height;

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imgData = new ImageData(new Uint8ClampedArray(rgba), w, h);
    ctx.putImageData(imgData, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await blob.arrayBuffer();
  } catch (e: unknown) {
    console.error("[AttachHub] TIFF decode failed:", e);
    return null;
  }
}
