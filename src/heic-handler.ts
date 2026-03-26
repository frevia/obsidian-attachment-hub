/**
 * HEIC/HEIF decoder using heic2any.
 * Converts static HEIC images to PNG for further Canvas API processing.
 */

import heic2any from "heic2any";

export async function decodeHeic(data: ArrayBuffer): Promise<ArrayBuffer | null> {
  try {
    const blob = new Blob([data], { type: "image/heic" });
    const result = await (heic2any as any)({ blob, toType: "image/png", multiple: false });
    const outBlob = Array.isArray(result) ? result[0] : result;
    return await outBlob.arrayBuffer();
  } catch (e) {
    console.error("[AttachHub] HEIC decode failed:", e);
    return null;
  }
}
