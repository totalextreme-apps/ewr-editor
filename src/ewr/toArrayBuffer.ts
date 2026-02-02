// /Users/mac1/Desktop/ewr_editor/src/ewr/toArrayBuffer.ts

/**
 * Tauri fs readFile() returns Uint8Array.
 * DataView requires an ArrayBuffer.
 *
 * IMPORTANT: u8.buffer may include extra bytes, so we slice using byteOffset/byteLength.
 */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
