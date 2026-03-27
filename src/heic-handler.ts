/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
/**
 * HEIC/HEIF decoder using heic2any.
 * Converts static HEIC images to PNG for further Canvas API processing.
 */

import heic2any from "heic2any";

export async function decodeHeic(data: ArrayBuffer): Promise<ArrayBuffer | null> {
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
