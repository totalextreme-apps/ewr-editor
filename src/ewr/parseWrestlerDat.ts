// /Users/mac1/Desktop/ewr_editor/src/ewr/parseWrestlerDat.ts

import schemaJson from "./wrestler_dat_schema.json";
import { validateWrestlerDatSchema, type WrestlerDatSchema } from "./schemaValidate";

export type Worker = {
  index: number;
  id: number;
  [key: string]: any;
};

class Bin {
  private view: DataView;
  private bytes: Uint8Array;

  constructor(arrayBuffer: ArrayBuffer) {
    this.view = new DataView(arrayBuffer);
    this.bytes = new Uint8Array(arrayBuffer);
  }

  size(): number {
    return this.bytes.length;
  }

  u8(offset: number): number {
    return this.view.getUint8(offset);
  }

  u16le(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  asciiFixed(offset: number, length: number): string {
    const slice = this.bytes.slice(offset, offset + length);

    let s = "";
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i];
      if (c === 0x00) break;
      s += String.fromCharCode(c);
    }

    return s.replace(/\0/g, "").trim();
  }
}

export function parseWrestlerDat(arrayBuffer: ArrayBuffer): Worker[] {
  const schema = schemaJson as unknown as WrestlerDatSchema;

  // ✅ Hard validation: bounds + overlaps + header ranges
  validateWrestlerDatSchema(schema);

  const bin = new Bin(arrayBuffer);

  const recordSize = schema.recordSize;
  const markerOffset = schema.recordHeader.marker.offset;
  const markerValue = schema.recordHeader.marker.value;
  const idOffset = schema.recordHeader.workerId.offset;

  const fileSize = bin.size();
  if (fileSize < recordSize) {
    throw new Error(`File too small: ${fileSize} bytes (expected at least ${recordSize})`);
  }
  if (fileSize % recordSize !== 0) {
    throw new Error(`File size ${fileSize} is not a multiple of recordSize ${recordSize}.`);
  }

  const totalRecords = fileSize / recordSize;
  const workers: Worker[] = [];

  for (let index = 0; index < totalRecords; index++) {
    const recordStart = index * recordSize;

    const marker = bin.u8(recordStart + markerOffset);
    if (marker !== markerValue) {
      throw new Error(
        `Invalid record marker at index ${index} (offset ${recordStart + markerOffset}). Expected ${markerValue}, got ${marker}.`
      );
    }

    const id = bin.u16le(recordStart + idOffset);

    const w: Worker = { index, id };

    for (const f of schema.fields) {
      const abs = recordStart + f.offset;

      if (f.type === "u8") {
        w[f.name] = bin.u8(abs);
      } else if (f.type === "u16le") {
        w[f.name] = bin.u16le(abs);
      } else if (f.type === "ascii_fixed") {
        const len = f.length ?? 0;
        w[f.name] = bin.asciiFixed(abs, len);
      } else {
        throw new Error(`Unsupported field type "${(f as any).type}"`);
      }
    }

    // Convenience normalized fields (non-destructive)
    if (typeof w.birthMonthRaw === "number") w.birthMonth = w.birthMonthRaw & 0xff;
    if (typeof w.weightRaw === "number") w.weight = w.weightRaw & 0xff;
    if (typeof w.ageRaw === "number") w.age = w.ageRaw & 0xff;
    if (typeof w.wageThousandsRaw === "number") w.wageDollars = w.wageThousandsRaw * 1000;

    workers.push(w);
  }

  return workers;
}
