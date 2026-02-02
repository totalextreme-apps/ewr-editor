// /Users/mac1/Desktop/ewr_editor/src/ewr/writeWrestlerDat.ts

import schemaJson from "./wrestler_dat_schema.json";
import type { Worker } from "./parseWrestlerDat";
import { validateWrestlerDatSchema, type WrestlerDatSchema } from "./schemaValidate";

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function writeU8(bytes: Uint8Array, abs: number, v: number) {
  bytes[abs] = clampInt(v, 0, 255);
}

function writeU16LE(bytes: Uint8Array, abs: number, v: number) {
  const n = clampInt(v, 0, 65535);
  bytes[abs] = n & 0xff;
  bytes[abs + 1] = (n >> 8) & 0xff;
}

function toAsciiFixedBytes(value: unknown, length: number): Uint8Array {
  const s = (value ?? "").toString();

  const out = new Uint8Array(length);
  out.fill(0x20); // space padding

  let j = 0;
  for (let i = 0; i < s.length && j < length; i++) {
    const code = s.charCodeAt(i);
    out[j++] = code <= 0x7f ? code : 0x3f;
  }

  return out;
}

function normalizePhotoNameForWrite(input: unknown, maxLen: number): string {
  let s = (input ?? "").toString().trim();
  if (!s) return "";

  const lower = s.toLowerCase();
  const hasJpg = lower.endsWith(".jpg");
  const hasJpeg = lower.endsWith(".jpeg");

  if (!hasJpg && !hasJpeg) s = `${s}.jpg`;

  const lower2 = s.toLowerCase();
  const ext = lower2.endsWith(".jpeg") ? ".jpeg" : ".jpg";
  const extLen = ext.length;

  // Preserve extension when truncating
  if (s.length > maxLen) {
    const baseMax = Math.max(0, maxLen - extLen);
    const base = s.slice(0, s.length - extLen);
    s = base.slice(0, baseMax) + ext;
  }

  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function validateOutputMarkers(out: Uint8Array, recordSize: number, markerOffset: number, markerValue: number) {
  if (out.length % recordSize !== 0) {
    throw new Error(`Output size ${out.length} not multiple of recordSize ${recordSize}`);
  }
  const total = out.length / recordSize;
  for (let i = 0; i < total; i++) {
    const start = i * recordSize;
    if (out[start + markerOffset] !== markerValue) {
      throw new Error(`Output corruption: marker mismatch at record ${i}`);
    }
  }
}

export function writeWrestlerDat(originalBytes: Uint8Array, workers: Worker[]): Uint8Array {
  const schema = schemaJson as unknown as WrestlerDatSchema;

  // ✅ Hard validation: bounds + overlaps + header ranges
  validateWrestlerDatSchema(schema);

  const recordSize = schema.recordSize;
  const markerOffset = schema.recordHeader.marker.offset;
  const markerValue = schema.recordHeader.marker.value;

  if (originalBytes.length % recordSize !== 0) {
    throw new Error(`Input size ${originalBytes.length} is not multiple of recordSize ${recordSize}`);
  }

  const out = new Uint8Array(originalBytes);
  const totalRecords = out.length / recordSize;

  for (const w of workers) {
    const index = w.index;
    if (!Number.isFinite(index) || index < 0 || index >= totalRecords) {
      throw new Error(`Worker index out of bounds: ${index} (total ${totalRecords})`);
    }

    const recordStart = index * recordSize;

    // refuse to write if record marker doesn't match
    const marker = out[recordStart + markerOffset];
    if (marker !== markerValue) {
      throw new Error(`Refusing to write: marker mismatch at record ${index}`);
    }

    for (const f of schema.fields) {
      if (!Object.prototype.hasOwnProperty.call(w, f.name)) continue;

      const abs = recordStart + f.offset;

      if (f.type === "u8") {
        writeU8(out, abs, Number((w as any)[f.name] ?? 0));
      } else if (f.type === "u16le") {
        writeU16LE(out, abs, Number((w as any)[f.name] ?? 0));
      } else if (f.type === "ascii_fixed") {
        const len = f.length ?? 0;

        let valueToWrite: unknown = (w as any)[f.name];
        if (f.name === "photoName") {
          valueToWrite = normalizePhotoNameForWrite(valueToWrite, len);
        }

        const bytes = toAsciiFixedBytes(valueToWrite, len);
        out.set(bytes, abs);
      } else {
        throw new Error(`Unsupported field type "${(f as any).type}"`);
      }
    }
  }

  validateOutputMarkers(out, recordSize, markerOffset, markerValue);
  return out;
}
