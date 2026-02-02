// /Users/mac1/Desktop/ewr_editor/src/ewr/schemaValidate.ts

export type FieldType = "u8" | "u16le" | "ascii_fixed";

export type SchemaField = {
  name: string;
  offset: number; // 0-based, relative to start of record
  type: FieldType;
  length?: number; // required for ascii_fixed
  note?: string;
};

export type WrestlerDatSchema = {
  file?: string;
  recordSize: number;
  recordHeader: {
    marker: { offset: number; type: "u8"; value: number; note?: string };
    workerId: { offset: number; type: "u16le" };
    dataStartsAt?: number;
  };
  fields: SchemaField[];
  mappings?: Record<string, any>;
  notes?: string[];
};

function sizeOfField(f: SchemaField): number {
  if (f.type === "u8") return 1;
  if (f.type === "u16le") return 2;
  if (f.type === "ascii_fixed") {
    if (typeof f.length !== "number" || f.length <= 0) return 0;
    return f.length;
  }
  return 0;
}

function assertFiniteInt(n: unknown, label: string) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`Schema invalid: ${label} must be a finite number`);
  }
}

function assertNonEmptyString(s: unknown, label: string) {
  if (typeof s !== "string" || s.trim().length === 0) {
    throw new Error(`Schema invalid: ${label} must be a non-empty string`);
  }
}

type Range = { name: string; start: number; end: number };

function assertRangeInBounds(r: Range, recordSize: number) {
  if (r.start < 0) throw new Error(`Schema invalid: "${r.name}" start < 0 (${r.start})`);
  if (r.end <= r.start) throw new Error(`Schema invalid: "${r.name}" has non-positive length (${r.start}..${r.end})`);
  if (r.end > recordSize) {
    throw new Error(
      `Schema invalid: "${r.name}" ends at ${r.end} but recordSize is ${recordSize} (out of bounds)`
    );
  }
}

function assertNoOverlaps(ranges: Range[]) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];

    // Overlap if current starts before previous ends
    if (cur.start < prev.end) {
      throw new Error(
        `Schema invalid: overlapping fields: "${prev.name}" [${prev.start}..${prev.end}) overlaps "${cur.name}" [${cur.start}..${cur.end})`
      );
    }
  }
}

/**
 * Validates:
 * - recordSize present and > 0
 * - recordHeader marker and workerId in bounds
 * - every field has valid name/offset/type/length
 * - every field fits inside recordSize
 * - NO overlapping byte ranges between any fields AND the header ranges
 */
export function validateWrestlerDatSchema(schema: WrestlerDatSchema) {
  if (!schema) throw new Error("Schema invalid: missing schema object");

  assertFiniteInt(schema.recordSize, "recordSize");
  if (schema.recordSize <= 0) throw new Error("Schema invalid: recordSize must be > 0");

  if (!schema.recordHeader?.marker) throw new Error("Schema invalid: recordHeader.marker missing");
  if (!schema.recordHeader?.workerId) throw new Error("Schema invalid: recordHeader.workerId missing");

  // Validate marker
  assertFiniteInt(schema.recordHeader.marker.offset, "recordHeader.marker.offset");
  assertFiniteInt(schema.recordHeader.marker.value, "recordHeader.marker.value");

  // Validate workerId
  assertFiniteInt(schema.recordHeader.workerId.offset, "recordHeader.workerId.offset");

  if (!Array.isArray(schema.fields)) throw new Error("Schema invalid: fields missing/invalid");

  const ranges: Range[] = [];

  // Reserve header bytes as well (so fields can't overlap them)
  // marker: u8 at offset marker.offset
  const markerRange: Range = {
    name: "recordHeader.marker",
    start: schema.recordHeader.marker.offset,
    end: schema.recordHeader.marker.offset + 1,
  };
  assertRangeInBounds(markerRange, schema.recordSize);
  ranges.push(markerRange);

  // workerId: u16le at offset workerId.offset (2 bytes)
  const idRange: Range = {
    name: "recordHeader.workerId",
    start: schema.recordHeader.workerId.offset,
    end: schema.recordHeader.workerId.offset + 2,
  };
  assertRangeInBounds(idRange, schema.recordSize);
  ranges.push(idRange);

  // Validate fields + build ranges
  for (const f of schema.fields) {
    assertNonEmptyString(f.name, "field.name");
    assertFiniteInt(f.offset, `field "${f.name}".offset`);
    if (f.offset < 0) throw new Error(`Schema invalid: field "${f.name}" offset < 0 (${f.offset})`);

    if (f.type !== "u8" && f.type !== "u16le" && f.type !== "ascii_fixed") {
      throw new Error(`Schema invalid: field "${f.name}" has unsupported type "${(f as any).type}"`);
    }

    if (f.type === "ascii_fixed") {
      assertFiniteInt(f.length, `field "${f.name}".length`);
      if ((f.length ?? 0) <= 0) throw new Error(`Schema invalid: field "${f.name}" ascii_fixed length must be > 0`);
    }

    const size = sizeOfField(f);
    if (size <= 0) throw new Error(`Schema invalid: field "${f.name}" has invalid computed size`);

    const r: Range = { name: f.name, start: f.offset, end: f.offset + size };
    assertRangeInBounds(r, schema.recordSize);
    ranges.push(r);
  }

  // Ensure no overlaps (header + all fields)
  assertNoOverlaps(ranges);
}
