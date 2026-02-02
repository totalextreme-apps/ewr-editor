// src/App.tsx

import React, { useMemo, useRef, useState } from "react";
import { List, type RowComponentProps } from "react-window";

import schemaJson from "./ewr/wrestler_dat_schema.json";
import { parseWrestlerDat, type Worker } from "./ewr/parseWrestlerDat";
import { validateWrestlerDatBytes } from "./ewr/validateWrestlerDat";
import { writeWrestlerDat } from "./ewr/writeWrestlerDat";

// Tauri v2 plugins
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, exists, copyFile } from "@tauri-apps/plugin-fs";

// Logo
import ewrLogo from "./assets/ewr_edit_logo.png";

// --- emergency crash overlay (shows errors inside the window) ---
// IMPORTANT: must be AFTER imports in ESM/TS projects.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("error", (e) => {
    document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:16px;font-family:monospace;color:#fff;background:#000">
RUNTIME ERROR:
${String((e as any).message || (e as any).error || e)}
</pre>`;
  });

  window.addEventListener("unhandledrejection", (e: any) => {
    document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:16px;font-family:monospace;color:#fff;background:#000">
UNHANDLED PROMISE:
${String(e?.reason?.message || e?.reason || e)}
</pre>`;
  });
}

const schema: any = schemaJson;

// ---------- helpers ----------
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// Concatenate two Uint8Arrays (used when appending new fixed-size records)
function concatByteArrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}


function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isTruthy16(v: any) {
  return Number(v) !== 0;
}

function setBool16(checked: boolean) {
  return checked ? 65535 : 0;
}

function setLowByteU16(oldVal: number, lowByte: number) {
  const hi = (oldVal & 0xff00) >>> 0;
  const lo = lowByte & 0xff;
  return (hi | lo) & 0xffff;
}

function truncateAscii(s: string, maxLen: number): string {
  if (!s) return "";
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

function sanitizePhotoBaseName(input: string): string {
  const s = (input ?? "").trim();
  const stripped = s.replace(/[.:*?"<>|\/\\]/g, "");
  return stripped.replace(/\s+/g, " ").trim();
}

function sanitizeAndTruncatePhotoBase(input: string): string {
  const sanitized = sanitizePhotoBaseName(input);
  return truncateAscii(sanitized, 20);
}

function stripImageExtension(name: string): string {
  const s = (name ?? "").trim();
  return s.replace(/\.(jpg|jpeg|png|gif)$/i, "");
}

/**
 * Native behavior observed:
 * - if base is empty OR base equals "None" (case-insensitive), write "None" exactly (no .jpg)
 * - otherwise append .jpg
 */
function normalizePhotoNameForWrite(inputBase: string) {
  const base = sanitizeAndTruncatePhotoBase(stripImageExtension(inputBase));
  if (!base) return "None";
  if (base.toLowerCase() === "none") return "None";
  return `${base}.jpg`;
}

function fullNameToUnderscore(fullName: string) {
  return (fullName ?? "").trim().replace(/\s+/g, "_");
}

// ---------- finisher type ----------
function decodeFinisherTypeFromABC(Araw: number, Braw: number, Craw: number): string {
  const a = Araw !== 0;
  const b = Braw !== 0;
  const c = Craw !== 0;

  if (!a && !b && !c) return "Impact";
  if (a && !b && !c) return "Submission";
  if (a && b && !c) return "Top Rope Standing";
  if (!a && b && !c) return "Top Rope";
  if (!a && !b && c) return "Ground";
  if (!a && b && c) return "Corner";

  return "Impact";
}

function encodeFinisherTypeToABC(type: string): { A: number; B: number; C: number } {
  switch (type) {
    case "Submission":
      return { A: 65535, B: 0, C: 0 };
    case "Top Rope Standing":
      return { A: 65535, B: 65535, C: 0 };
    case "Top Rope":
      return { A: 0, B: 65535, C: 0 };
    case "Ground":
      return { A: 0, B: 0, C: 65535 };
    case "Corner":
      return { A: 0, B: 65535, C: 65535 };
    case "Impact":
    default:
      return { A: 0, B: 0, C: 0 };
  }
}

// ---------- CSV helpers ----------
type CsvRecord = Record<string, string>;

function csvEscape(value: any): string {
  const s = (value ?? "").toString();
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// RFC4180-ish parser: handles quoted fields, commas, CRLF/LF.
function parseCsv(text: string): { headers: string[]; rows: CsvRecord[] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }

    if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }

    if (ch === "\r") {
      // ignore; handle CRLF by letting \n close the row
      continue;
    }

    cur += ch;
  }

  // flush tail
  row.push(cur);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  const out: CsvRecord[] = [];

  for (const r of rows) {
    if (r.every((c) => (c ?? "").trim() === "")) continue;
    const rec: CsvRecord = {};
    for (let i = 0; i < headers.length; i++) {
      const k = headers[i];
      if (!k) continue;
      rec[k] = (r[i] ?? "").trim();
    }
    out.push(rec);
  }

  return { headers, rows: out };
}

function makeReverseMap(map: Record<string, string> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!map) return out;
  for (const [k, v] of Object.entries(map)) {
    out[String(v).trim().toLowerCase()] = Number(k);
  }
  return out;
}

function parseYesNo(v: string): boolean | null {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return null;
  // Accept numeric truthy/falsey (e.g. legacy exports using 255 / 65535)
  const asNum = Number(s);
  if (Number.isFinite(asNum)) return asNum !== 0;
  if (["y", "yes", "true", "1"].includes(s)) return true;
  if (["n", "no", "false", "0"].includes(s)) return false;
  return null;
}

function makeOptionsFromMapping(mapping: Record<string, any> | undefined, fallback: Record<string, string>) {
  const obj = mapping && Object.keys(mapping).length ? mapping : fallback;
  return Object.entries(obj)
    .map(([k, v]) => ({ value: Number(k), label: String(v) }))
    .sort((a, b) => a.value - b.value);
}

const fallbackBirthMonths: Record<string, string> = {
  "0": "Unknown",
  "1": "January",
  "2": "February",
  "3": "March",
  "4": "April",
  "5": "May",
  "6": "June",
  "7": "July",
  "8": "August",
  "9": "September",
  "10": "October",
  "11": "November",
  "12": "December",
};

const fallbackNationalities: Record<string, string> = {
  "0": "Other",
  "1": "American",
  "2": "Australian",
  "3": "British",
  "4": "Canadian",
  "5": "European",
  "6": "Japanese",
  "7": "Mexican",
};

const weightOptions = [
  { value: 72, label: "Heavyweight" },
  { value: 76, label: "Lightweight" },
];

const finisherTypeOptions = ["Impact", "Submission", "Top Rope Standing", "Top Rope", "Ground", "Corner"];

// Key helpers
function getNum(w: any, ...keys: string[]): number {
  for (const k of keys) {
    if (w && k in w && typeof w[k] === "number") return Number(w[k]);
  }
  return 0;
}
function getStr(w: any, ...keys: string[]): string {
  for (const k of keys) {
    if (w && k in w && typeof w[k] === "string") return String(w[k]);
  }
  return "";
}
function hasKey(w: any, key: string) {
  return w && Object.prototype.hasOwnProperty.call(w, key);
}
function setNumPatch(w: any, preferred: string, fallback: string, value: number) {
  if (hasKey(w, preferred)) return { [preferred]: value };
  if (hasKey(w, fallback)) return { [fallback]: value };
  return { [preferred]: value };
}
function setStrPatch(w: any, preferred: string, fallback: string, value: string) {
  if (hasKey(w, preferred)) return { [preferred]: value };
  if (hasKey(w, fallback)) return { [fallback]: value };
  return { [preferred]: value };
}

// Numeric input that supports typing + arrows (commit on blur/enter)
function NumberInput(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  className?: string;
}) {
  const { value, min, max, step = 1, onChange, className } = props;
  const [draft, setDraft] = useState<string>(String(value));

  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <input
      type="number"
      className={className}
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number(draft);
        const clamped = clamp(n, min, max);
        setDraft(String(clamped));
        onChange(clamped);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ---------- small "grid cell" inputs (commit on blur/enter, low overhead) ----------
type GridNavRequest =
  | { kind: "tab"; shift: boolean }
  | { kind: "enter"; shift: boolean }
  | { kind: "arrow"; key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" };

function GridNumberCell(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (next: number) => void;

  // spreadsheet nav
  gridRowPos?: number; // row index in gridRows
  gridColPos?: number; // col index in editable columns
  onNav?: (rowPos: number, colPos: number, req: GridNavRequest) => void;
}) {
  const { value, min, max, step = 1, onCommit, gridRowPos, gridColPos, onNav } = props;
  const [draft, setDraft] = useState<string>(String(value));

  React.useEffect(() => setDraft(String(value)), [value]);

  return (
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      data-grid-row={gridRowPos}
      data-grid-col={gridColPos}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number(draft);
        const clamped = clamp(n, min, max);
        setDraft(String(clamped));
        onCommit(clamped);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(String(value));
          (e.target as HTMLInputElement).blur();
          return;
        }

        if (e.key === "Tab" && onNav != null && gridRowPos != null && gridColPos != null) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          requestAnimationFrame(() => onNav(gridRowPos, gridColPos, { kind: "tab", shift: e.shiftKey }));
          return;
        }

        if (e.key === "Enter" && onNav != null && gridRowPos != null && gridColPos != null) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          requestAnimationFrame(() => onNav(gridRowPos, gridColPos, { kind: "enter", shift: e.shiftKey }));
          return;
        }

        const isNavChord =
          (e.ctrlKey || e.metaKey) &&
          (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight");
        if (isNavChord && onNav != null && gridRowPos != null && gridColPos != null) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          requestAnimationFrame(() => onNav(gridRowPos, gridColPos, { kind: "arrow", key: e.key as any }));
          return;
        }
      }}
      style={{
        width: "100%",
        height: 30,
        borderRadius: 10,
        padding: "6px 10px",
        border: "1px solid rgba(255,255,255,0.14)",
        background: "rgba(255,255,255,0.06)",
        color: "rgba(255,255,255,0.95)",
        outline: "none",
      }}
    />
  );
}

function GridTextCell(props: {
  value: string;
  maxLen: number;
  onCommit: (next: string) => void;

  // spreadsheet nav
  gridRowPos?: number;
  gridColPos?: number;
  onNav?: (rowPos: number, colPos: number, req: GridNavRequest) => void;
}) {
  const { value, maxLen, onCommit, gridRowPos, gridColPos, onNav } = props;
  const [draft, setDraft] = useState<string>(value);

  React.useEffect(() => setDraft(value), [value]);

  return (
    <input
      type="text"
      value={draft}
      maxLength={maxLen}
      data-grid-row={gridRowPos}
      data-grid-col={gridColPos}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = truncateAscii(draft ?? "", maxLen);
        setDraft(next);
        onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
          return;
        }

        if (e.key === "Tab" && onNav != null && gridRowPos != null && gridColPos != null) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          requestAnimationFrame(() => onNav(gridRowPos, gridColPos, { kind: "tab", shift: e.shiftKey }));
          return;
        }

        if (e.key === "Enter" && onNav != null && gridRowPos != null && gridColPos != null) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          requestAnimationFrame(() => onNav(gridRowPos, gridColPos, { kind: "enter", shift: e.shiftKey }));
          return;
        }

        const isNavChord =
          (e.ctrlKey || e.metaKey) &&
          (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight");
        if (isNavChord && onNav != null && gridRowPos != null && gridColPos != null) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          requestAnimationFrame(() => onNav(gridRowPos, gridColPos, { kind: "arrow", key: e.key as any }));
          return;
        }
      }}
      style={{
        width: "100%",
        height: 30,
        borderRadius: 10,
        padding: "6px 10px",
        border: "1px solid rgba(255,255,255,0.14)",
        background: "rgba(255,255,255,0.06)",
        color: "rgba(255,255,255,0.95)",
        outline: "none",
      }}
    />
  );
}

// ---------- icons ----------
function IconCopy(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 7.5h9a2 2 0 0 1 2 2v9A2.5 2.5 0 0 1 16.5 21H9.5A2.5 2.5 0 0 1 7 18.5v-9A2 2 0 0 1 8 7.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M5 16.5H4.5A2.5 2.5 0 0 1 2 14V5.5A2.5 2.5 0 0 1 4.5 3h8.5A2.5 2.5 0 0 1 15.5 5.5V6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconTrash(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 3h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 6h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M8 6l1 15a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2l1-15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M10.5 10.5v8M13.5 10.5v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconFolderOpen(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v2H3V7Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M3 11h18l-2 9H5l-2-9Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}


function IconImport(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7a2 2 0 0 1 2-2h6l2 2h4a2 2 0 0 1 2 2v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M4 10h16v10H4V10Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 12v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9.5 14.5 12 12l2.5 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSave(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 4h12l2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M7 4v6h10V4" stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M8 20v-6h8v6" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function IconPlus(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconChecklist(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 6h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 18h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M3.5 6l1.5 1.5L7.5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 12l1.5 1.5L7.5 11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 18l1.5 1.5L7.5 17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconGrid(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 4h7v7H4V4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13 4h7v7h-7V4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M4 13h7v7H4v-7Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13 13h7v7h-7v-7Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function IconBack(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------- bytes helpers ----------
function setU16LE(bytes: Uint8Array, abs: number, value: number) {
  const v = clamp(Math.trunc(value), 0, 65535);
  bytes[abs] = v & 0xff;
  bytes[abs + 1] = (v >> 8) & 0xff;
}

function concatBytes(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function sliceRemove(bytes: Uint8Array, start: number, end: number) {
  const out = new Uint8Array(bytes.length - (end - start));
  out.set(bytes.slice(0, start), 0);
  out.set(bytes.slice(end), start);
  return out;
}

/**
 * Employment strip offsets (record-local)
 * Derived from wrestler_employed.dat vs wrestler_unemployed.dat diff.
 */
const EMPLOYMENT_CLEAR: Array<{ off: number; value: number }> = [
  { off: 65, value: 0 },
  { off: 67, value: 0 },
  { off: 69, value: 0 },
  { off: 71, value: 78 },
  { off: 72, value: 111 },
  { off: 82, value: 0 },
  { off: 84, value: 0 },
  { off: 86, value: 0 },
  { off: 167, value: 0 },
  { off: 169, value: 0 },
  { off: 171, value: 0 },
];

function stripEmploymentInRecordBytes(recordBytes: Uint8Array) {
  for (const e of EMPLOYMENT_CLEAR) {
    if (e.off >= 0 && e.off < recordBytes.length) recordBytes[e.off] = e.value & 0xff;
  }
}

// ---------- copy naming ----------
function makeUniqueFullName(base: string, existing: Set<string>) {
  const trimmed = (base ?? "").trim();
  const b = trimmed || "New Worker";
  if (!existing.has(b.toLowerCase())) return b;

  for (let i = 1; i < 999; i++) {
    const candidate = `${b} (${i})`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${b} (copy)`;
}

// ---------- hook: measure element size (for list height) ----------
// Robust against environments where ResizeObserver can be flaky/late.
// We measure immediately (layout), on window resize, and via ResizeObserver when available.
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.floor(r.width);
    const h = Math.floor(r.height);
    if (w !== size.width || h !== size.height) setSize({ width: w, height: h });
  }, [size.width, size.height]);

  React.useLayoutEffect(() => {
    measure();

    const onWinResize = () => measure();
    window.addEventListener("resize", onWinResize);

    // Some WebViews don't fire ResizeObserver for flex children immediately;
    // keep RO but don't depend on it exclusively.
    let ro: ResizeObserver | null = null;
    const el = ref.current;

    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(el);
    }

    // One extra tick after layout to catch late font/layout changes.
    const raf = requestAnimationFrame(() => measure());

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWinResize);
      try {
        ro?.disconnect();
      } catch {}
    };
  }, [measure]);

  return { ref, size };
}

// ---------- Comparative Skills Grid types ----------
type ViewMode = "profile" | "grid";

type GridSortKey =
  | "index"
  | "id"
  | "fullName"
  | "shortName"
  | "brawling"
  | "speed"
  | "technical"
  | "stiffness"
  | "selling"
  | "overness"
  | "charisma"
  | "attitude"
  | "behaviour";

type GridColumn = {
  key: GridSortKey;
  label: string;
  width: number;
  kind: "num" | "text";
  maxLen?: number;
  min?: number;
  max?: number;
};


// ---------- Left-panel Filters ----------
type GenderFilter = "" | "male" | "female";


type TriState = "" | "yes" | "no";
type SkillFilterKey = Exclude<GridSortKey, "index" | "id" | "fullName" | "shortName">;

type SkillRangeFilter = {
  id: string;
  key: SkillFilterKey;
  min: string; // allow empty while typing
  max: string; // allow empty while typing
};

const SKILL_FILTER_META: { key: SkillFilterKey; raw: string; label: string }[] = [
  { key: "brawling", raw: "brawlingRaw", label: "Brawling" },
  { key: "speed", raw: "speedRaw", label: "Speed" },
  { key: "technical", raw: "technicalRaw", label: "Technical" },
  { key: "stiffness", raw: "stiffnessRaw", label: "Stiffness" },
  { key: "selling", raw: "sellingRaw", label: "Selling" },
  { key: "overness", raw: "overnessRaw", label: "Overness" },
  { key: "charisma", raw: "charismaRaw", label: "Charisma" },
  { key: "attitude", raw: "attitudeRaw", label: "Attitude" },
  { key: "behaviour", raw: "behaviourRaw", label: "Behaviour" },
];

const FLAG_FILTER_META: { key: string; raw: string; label: string; divaOnly?: boolean }[] = [
  { key: "superstarLook", raw: "superstarLookRaw", label: "Superstar Look" },
  { key: "menacing", raw: "menacingRaw", label: "Menacing" },
  { key: "fonzFactor", raw: "fonzFactorRaw", label: "Fonz Factor" },
  { key: "highSpots", raw: "highSpotsRaw", label: "High Spots" },
  { key: "shootingAbility", raw: "shootingAbilityRaw", label: "Shooting Ability" },
  { key: "trainer", raw: "trainerRaw", label: "Trainer" },
  { key: "announcer", raw: "announcerRaw", label: "Announcer" },
  { key: "booker", raw: "bookerRaw", label: "Booker" },
  { key: "diva", raw: "divaRaw", label: "Diva", divaOnly: true },
];

function parseMaybeInt(raw: string): number | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}
const GRID_COLUMNS: GridColumn[] = [
  { key: "index", label: "Record #", width: 90, kind: "num", min: 0, max: 99999 },
  { key: "id", label: "Worker ID", width: 90, kind: "num", min: 0, max: 65535 },
  { key: "fullName", label: "Full Name", width: 220, kind: "text", maxLen: 25 },
  { key: "shortName", label: "Short Name", width: 140, kind: "text", maxLen: 10 },
  { key: "brawling", label: "Brawling", width: 110, kind: "num", min: 0, max: 100 },
  { key: "speed", label: "Speed", width: 110, kind: "num", min: 0, max: 100 },
  { key: "technical", label: "Technical", width: 110, kind: "num", min: 0, max: 100 },
  { key: "stiffness", label: "Stiffness", width: 110, kind: "num", min: 0, max: 100 },
  { key: "selling", label: "Selling", width: 110, kind: "num", min: 0, max: 100 },
  { key: "overness", label: "Overness", width: 110, kind: "num", min: 0, max: 100 },
  { key: "charisma", label: "Charisma", width: 110, kind: "num", min: 0, max: 100 },
  { key: "attitude", label: "Attitude", width: 110, kind: "num", min: 0, max: 100 },
  { key: "behaviour", label: "Behaviour", width: 120, kind: "num", min: 0, max: 100 },
];

const GRID_TOTAL_WIDTH = GRID_COLUMNS.reduce((sum, c) => sum + c.width, 0);

// Only the editable columns participate in spreadsheet-style navigation.
const GRID_EDITABLE_KEYS: GridSortKey[] = [
  "fullName",
  "shortName",
  "brawling",
  "speed",
  "technical",
  "stiffness",
  "selling",
  "overness",
  "charisma",
  "attitude",
  "behaviour",
];

const GRID_EDIT_COL_COUNT = GRID_EDITABLE_KEYS.length;

// ---------- component ----------
export default function App() {
  const birthMonthOptions = useMemo(
    () => makeOptionsFromMapping(schema?.mappings?.birthMonthRaw_lowByte, fallbackBirthMonths),
    []
  );
  const nationalityOptions = useMemo(
    () => makeOptionsFromMapping(schema?.mappings?.nationalityRaw, fallbackNationalities),
    []
  );

  // react-window v2 typings don't currently expose a `ref` prop on <List> in a way
  // that plays nicely with React 19 + TS, but we rely on the imperative API
  // (e.g., scrollToRow/scrollToItem). Cast once and keep the call sites clean.
  const VirtualList: any = List;

  const [filePath, setFilePath] = useState<string | null>(null);
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);

  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedRecordIndex, setSelectedRecordIndex] = useState<number>(0);

  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<"id" | "name">("id");

  // Filters (applied in addition to Search/Sort)
  const [filterNationality, setFilterNationality] = useState<number | "">("");
  const [filterGender, setFilterGender] = useState<GenderFilter>("");
  const [skillRangeFilters, setSkillRangeFilters] = useState<SkillRangeFilter[]>([
    { id: "sf-1", key: "brawling", min: "", max: "" },
  ]);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState<boolean>(false);

  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);

  const [filterWageMin, setFilterWageMin] = useState<string>("");
  const [filterWageMax, setFilterWageMax] = useState<string>("");

  const [filterAgeMin, setFilterAgeMin] = useState<string>("");
  const [filterAgeMax, setFilterAgeMax] = useState<string>("");

  const [filterWeight, setFilterWeight] = useState<number | "">("");
  const [filterBirthMonth, setFilterBirthMonth] = useState<number | "">("");

  const [filterSpeaks, setFilterSpeaks] = useState<TriState>("");

  const [filterPrimaryFinisherType, setFilterPrimaryFinisherType] = useState<string>("");
  const [filterSecondaryFinisherType, setFilterSecondaryFinisherType] = useState<string>("");

  const [flagFilters, setFlagFilters] = useState<Record<string, TriState>>({
    superstarLook: "",
    menacing: "",
    fonzFactor: "",
    highSpots: "",
    shootingAbility: "",
    trainer: "",
    announcer: "",
    booker: "",
    diva: "",
  });

  const [status, setStatus] = useState<string>("");
  const [photoWarn, setPhotoWarn] = useState<string>("");

  const [multiDeleteMode, setMultiDeleteMode] = useState<boolean>(false);
  const [selectedForDelete, setSelectedForDelete] = useState<Set<number>>(new Set());

  const [viewMode, setViewMode] = useState<ViewMode>("profile");

  const [gridSearch, setGridSearch] = useState<string>("");
  const [gridFiltersOpen, setGridFiltersOpen] = useState<boolean>(false);
  const [gridSort, setGridSort] = useState<{ key: GridSortKey; dir: "asc" | "desc" }>({ key: "id", dir: "asc" });

  // Skills comparison (Profile view)
  const [compareInput, setCompareInput] = useState<string>("None");
  const [compareRecordIndex, setCompareRecordIndex] = useState<number | null>(null);
  const [compareOpen, setCompareOpen] = useState<boolean>(false);
  const [compareActive, setCompareActive] = useState<number>(0);
  const compareInputRef = useRef<HTMLInputElement | null>(null);


  // Import Worker (from another wrestler.dat)
  const [importModalOpen, setImportModalOpen] = useState<boolean>(false);
  const [importSourcePath, setImportSourcePath] = useState<string>("");
  const [importSourceBytes, setImportSourceBytes] = useState<Uint8Array | null>(null);
  const [importSourceWorkers, setImportSourceWorkers] = useState<Worker[]>([]);
  const [importSelection, setImportSelection] = useState<Set<number>>(new Set());
  const [importSearch, setImportSearch] = useState<string>("");
  const [importInfo, setImportInfo] = useState<string>("");


  // External Editing (CSV)
  const [externalEditingOpen, setExternalEditingOpen] = useState<boolean>(false);

  type CsvRowError = { row: number; field: string; message: string };
  type CsvUpdatePlan = { targetIndex: number; patch: Partial<Worker> };
  type CsvNewRowPlan = { data: Partial<Worker> & { fullName: string } };

  const [csvModalOpen, setCsvModalOpen] = useState<boolean>(false);
  const [csvSourcePath, setCsvSourcePath] = useState<string>("");
  const [csvRowCount, setCsvRowCount] = useState<number>(0);
  const [csvPlannedUpdates, setCsvPlannedUpdates] = useState<CsvUpdatePlan[]>([]);
  const [csvPlannedNewRows, setCsvPlannedNewRows] = useState<CsvNewRowPlan[]>([]);
  const [csvSkippedDuplicates, setCsvSkippedDuplicates] = useState<string[]>([]);
  const [csvInvalidRows, setCsvInvalidRows] = useState<CsvRowError[]>([]);
  const [csvImportInfo, setCsvImportInfo] = useState<string>("");

  const selectedWorker = useMemo(() => {
    const found = workers.find((w: any) => w.index === selectedRecordIndex);
    return found ?? workers[0] ?? null;
  }, [workers, selectedRecordIndex]);

  const compareWorker = useMemo(() => {
    if (compareRecordIndex == null) return null;
    const w = workers.find((x: any) => x.index === compareRecordIndex) ?? null;
    if (!w) return null;
    if (selectedWorker && (w as any).index === (selectedWorker as any).index) return null;
    return w;
  }, [compareRecordIndex, workers, selectedWorker]);

  const compareCatalog = useMemo(() => {
    const names: string[] = [];
    const map = new Map<string, number>();
    for (const w of workers as any[]) {
      if (selectedWorker && (w as any).index === (selectedWorker as any).index) continue;
      const name = String(getStr(w as any, "fullName")).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, (w as any).index);
        names.push(name);
      }
    }
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return { names, map };
  }, [workers, selectedWorker]);

  const applyCompareName = (rawName: string) => {
    const name = String(rawName ?? "").trim();
    if (!name || name.toLowerCase() === "none") {
      setCompareInput("None");
      setCompareRecordIndex(null);
      setCompareOpen(false);
      setCompareActive(0);
      return;
    }
    const idx = compareCatalog.map.get(name.toLowerCase());
    if (idx == null) {
      // Keep the typed value but do not set a comparison worker until it matches a real name.
      setCompareInput(name);
      setCompareRecordIndex(null);
      setCompareOpen(true);
      return;
    }
    const canonical = compareCatalog.names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
    setCompareInput(canonical);
    setCompareRecordIndex(idx);
    setCompareOpen(false);
    setCompareActive(0);
  };

  const getCompareFilteredNames = () => {
    const q = String(compareInput ?? "").trim().toLowerCase();
    const all = ["None", ...compareCatalog.names];
    const filtered = q && q !== "none" ? all.filter((n) => n.toLowerCase().includes(q)) : all;
    return filtered.slice(0, 60);
  };



  const profileFilteredWorkers = useMemo(() => {
    let list = workers;

    // Profile field filters
    if (filterNationality !== "") {
      const nat = Number(filterNationality);
      list = list.filter((w: any) => getNum(w, "nationalityRaw", "nationality") === nat);
    }

    if (filterGender) {
      const wantMale = filterGender === "male";
      list = list.filter((w: any) => {
        const g = getNum(w, "genderRaw", "gender");
        if (wantMale) return g === 65535;
        return g === 0;
      });
    }

    // Skill range filters (all must match)
    const preparedSkillRanges = skillRangeFilters
      .map((f) => {
        const meta = SKILL_FILTER_META.find((m) => m.key === f.key);
        const minN = parseMaybeInt(f.min);
        const maxN = parseMaybeInt(f.max);
        return {
          key: f.key,
          raw: meta?.raw ?? "",
          min: minN === null ? null : clamp(minN, 0, 100),
          max: maxN === null ? null : clamp(maxN, 0, 100),
        };
      })
      .filter((f) => !!f.raw && (f.min !== null || f.max !== null));

    if (preparedSkillRanges.length) {
      list = list.filter((w: any) => {
        for (const r of preparedSkillRanges) {
          const v = clamp(getNum(w, r.raw, r.key), 0, 100);
          if (r.min !== null && v < r.min) return false;
          if (r.max !== null && v > r.max) return false;
        }
        return true;
      });
    }

    // Numeric / enum filters
    const wageMinN = parseMaybeInt(filterWageMin);
    const wageMaxN = parseMaybeInt(filterWageMax);
    const ageMinN = parseMaybeInt(filterAgeMin);
    const ageMaxN = parseMaybeInt(filterAgeMax);

    if (wageMinN !== null || wageMaxN !== null) {
      const minW = wageMinN === null ? null : clamp(wageMinN, 0, 300000);
      const maxW = wageMaxN === null ? null : clamp(wageMaxN, 0, 300000);
      list = list.filter((w: any) => {
        const wageThousands = getNum(w, "wageThousandsRaw", "wageRaw");
        const wageDollars = getNum(w, "wageDollars") || wageThousands * 1000;
        const v = clamp(wageDollars, 0, 300000);
        if (minW !== null && v < minW) return false;
        if (maxW !== null && v > maxW) return false;
        return true;
      });
    }

    if (ageMinN !== null || ageMaxN !== null) {
      const minA = ageMinN === null ? null : clamp(ageMinN, 0, 70);
      const maxA = ageMaxN === null ? null : clamp(ageMaxN, 0, 70);
      list = list.filter((w: any) => {
        const raw = getNum(w, "age", "ageRaw");
        const v = clamp(raw & 0xff, 0, 70);
        if (minA !== null && v < minA) return false;
        if (maxA !== null && v > maxA) return false;
        return true;
      });
    }

    if (filterWeight !== "") {
      const want = Number(filterWeight) & 0xff;
      list = list.filter((w: any) => (getNum(w, "weight", "weightRaw") & 0xff) === want);
    }

    if (filterBirthMonth !== "") {
      const want = Number(filterBirthMonth) & 0xff;
      list = list.filter((w: any) => (getNum(w, "birthMonth", "birthMonthRaw") & 0xff) === want);
    }

    if (filterSpeaks) {
      const wantYes = filterSpeaks === "yes";
      list = list.filter((w: any) => {
        const v = isTruthy16(getNum(w, "speaksRaw", "speaks"));
        return wantYes ? v : !v;
      });
    }

    if (filterPrimaryFinisherType) {
      list = list.filter((w: any) => {
        const t = decodeFinisherTypeFromABC(
          getNum(w, "pfTypeFlagA", "primaryFinisherTypeFlagA"),
          getNum(w, "pfTypeFlagB", "primaryFinisherTypeFlagB"),
          getNum(w, "pfTypeFlagC", "primaryFinisherTypeFlagC")
        );
        return t === filterPrimaryFinisherType;
      });
    }

    if (filterSecondaryFinisherType) {
      list = list.filter((w: any) => {
        const t = decodeFinisherTypeFromABC(
          getNum(w, "sfTypeFlagA", "secondaryFinisherTypeFlagA"),
          getNum(w, "sfTypeFlagB", "secondaryFinisherTypeFlagB"),
          getNum(w, "sfTypeFlagC", "secondaryFinisherTypeFlagC")
        );
        return t === filterSecondaryFinisherType;
      });
    }

    // Attribute / role flags (tri-state). All active flags must match (AND).
    const activeFlags = FLAG_FILTER_META.filter((m) => !!flagFilters[m.key]);
    if (activeFlags.length) {
      list = list.filter((w: any) => {
        const g = getNum(w, "genderRaw", "gender");
        const isMale = g === 65535;
        for (const f of activeFlags) {
          const wantYes = flagFilters[f.key] === "yes";
          const v = isTruthy16(getNum(w, f.raw, f.key));
          if (f.divaOnly && wantYes) {
            // Diva only applies to female: require female AND flag true.
            if (isMale) return false;
            if (!v) return false;
            continue;
          }
          // For non-diva flags (or diva == no), treat as normal tri-state.
          if (wantYes && !v) return false;
          if (!wantYes && v) return false;
        }
        return true;
      });
    }
    return list;
  }, [workers, filterNationality, filterGender, filterBirthMonth, filterWeight, filterSpeaks, filterPrimaryFinisherType, filterSecondaryFinisherType, filterAgeMin, filterAgeMax, filterWageMin, filterWageMax, flagFilters, skillRangeFilters]);

  const filteredWorkers = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = profileFilteredWorkers;

    // Text search (name / short / ID)
    if (q) {
      list = list.filter((w: any) => {
        const name = String(w.fullName ?? "").toLowerCase();
        const shortName = String(w.shortName ?? "").toLowerCase();
        const id = String(w.id ?? "");
        return name.includes(q) || shortName.includes(q) || id.includes(q);
      });
    }

    const sorted = [...list].sort((a: any, b: any) => {
      if (sortMode === "id") return (a.id ?? 0) - (b.id ?? 0);
      return String(a.fullName ?? "")
        .toLowerCase()
        .localeCompare(String(b.fullName ?? "").toLowerCase());
    });

    return sorted;
  }, [profileFilteredWorkers, search, sortMode]);




  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filterNationality !== "") n++;
    if (filterGender) n++;
    for (const f of skillRangeFilters) {
      if (String(f.min ?? "").trim() || String(f.max ?? "").trim()) n++;
    }
    if (String(filterWageMin).trim() || String(filterWageMax).trim()) n++;
    if (String(filterAgeMin).trim() || String(filterAgeMax).trim()) n++;
    if (filterWeight !== "") n++;
    if (filterBirthMonth !== "") n++;
    if (filterSpeaks) n++;
    if (filterPrimaryFinisherType) n++;
    if (filterSecondaryFinisherType) n++;
    for (const meta of FLAG_FILTER_META) {
      if (flagFilters[meta.key]) n++;
    }
    return n;
  }, [
    filterNationality,
    filterGender,
    skillRangeFilters,
    filterWageMin,
    filterWageMax,
    filterAgeMin,
    filterAgeMax,
    filterWeight,
    filterBirthMonth,
    filterSpeaks,
    filterPrimaryFinisherType,
    filterSecondaryFinisherType,
    flagFilters,
  ]);

  const importVisibleWorkers = useMemo(() => {
    const q = importSearch.trim().toLowerCase();
    if (!q) return importSourceWorkers;
    return importSourceWorkers.filter((w: any) => String(w.fullName ?? "").toLowerCase().includes(q));
  }, [importSourceWorkers, importSearch]);

  function clearAllFilters() {
    setFilterNationality("");
    setFilterGender("");
    setSkillRangeFilters([{ id: "sf-1", key: "brawling", min: "", max: "" }]);
    setShowAdvancedFilters(false);

    setFilterWageMin("");
    setFilterWageMax("");
    setFilterAgeMin("");
    setFilterAgeMax("");
    setFilterWeight("");
    setFilterBirthMonth("");
    setFilterSpeaks("");
    setFilterPrimaryFinisherType("");
    setFilterSecondaryFinisherType("");

    setFlagFilters({
      superstarLook: "",
      menacing: "",
      fonzFactor: "",
      highSpots: "",
      shootingAbility: "",
      trainer: "",
      announcer: "",
      booker: "",
      diva: "",
    });
  }

  function updateSkillRangeFilter(id: string, patch: Partial<SkillRangeFilter>) {
    setSkillRangeFilters((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function removeSkillRangeFilter(id: string) {
    setSkillRangeFilters((prev) => {
      const next = prev.filter((f) => f.id !== id);
      return next.length ? next : [{ id: "sf-1", key: "brawling", min: "", max: "" }];
    });
  }

  function addSkillRangeFilter() {
    setSkillRangeFilters((prev) => [
      ...prev,
      { id: `sf-${Date.now()}-${Math.floor(Math.random() * 100000)}`, key: "brawling", min: "", max: "" },
    ]);
  }

  function computePhotoWarn(raw: string) {
    const base = stripImageExtension(raw);
    const sanitized = sanitizePhotoBaseName(base);
    const truncated = truncateAscii(sanitized, 20);

    const removedIllegal = base !== sanitized;
    const wasTruncated = sanitized.length !== truncated.length;

    if (!removedIllegal && !wasTruncated) return "";

    const parts: string[] = [];
    if (removedIllegal) parts.push('removed illegal characters (., : * ? " < > | and / \\)');
    if (wasTruncated) parts.push("truncated to 20 characters");

    return `Sanitized: ${parts.join(" + ")}.`;
  }

  async function onOpen() {
    setStatus("");
    try {
      const picked = await open({
        title: "Open wrestler.dat",
        multiple: false,
        filters: [{ name: "EWR wrestler.dat", extensions: ["dat"] }],
      });
      if (!picked) return;

      const path = Array.isArray(picked) ? picked[0] : picked;
      const bytes = await readFile(path);

      validateWrestlerDatBytes(bytes);

      const parsed = parseWrestlerDat(toArrayBuffer(bytes));

      const normalized = parsed.map((w: any) => {
        const out = { ...w };
        if (typeof out.photoName === "string") {
          const base = stripImageExtension(out.photoName);
          const clean = sanitizeAndTruncatePhotoBase(base);
          out.photoName = clean || "None";
        } else {
          out.photoName = "None";
        }
        return out;
      });

      setFilePath(path);
      setRawBytes(bytes);
      setWorkers(normalized as any);

      setSelectedRecordIndex((normalized[0] as any)?.index ?? 0);
      setPhotoWarn("");
      setStatus(`Loaded: ${normalized.length} workers`);

      setMultiDeleteMode(false);
      setSelectedForDelete(new Set());
      setViewMode("profile");
    } catch (e: any) {
      console.error(e);
      setStatus(`Open failed: ${e?.message ?? String(e)}`);
    }
  }

  function updateSelected(patch: Partial<Worker>) {
    if (!selectedWorker) return;
    const recordIndex = (selectedWorker as any).index;

    setWorkers((prev) => {
      const next = prev.map((w: any) => {
        if (w.index !== recordIndex) return w;
        const cur = { ...w };
        Object.assign(cur, patch);
        return cur;
      });
      return next as any;
    });
  }

  function updateWorkerByIndex(recordIndex: number, patch: Partial<Worker>) {
    setWorkers((prev) => {
      const next = prev.map((w: any) => {
        if (w.index !== recordIndex) return w;
        const cur = { ...w };
        Object.assign(cur, patch);
        return cur;
      });
      return next as any;
    });
  }

  async function onSave() {
    setStatus("");
    try {
      if (!filePath || !rawBytes) throw new Error("No file loaded.");
      if (!workers.length) throw new Error("No workers loaded.");

      const normalized = workers.map((w: any) => {
        const copy = { ...w };

        if (typeof copy.photoName === "string") {
          copy.photoName = normalizePhotoNameForWrite(copy.photoName);
        } else {
          copy.photoName = "None";
        }

        const ageVal = getNum(copy, "ageRaw", "age");
        Object.assign(copy, setNumPatch(copy, "ageRaw", "age", clamp(ageVal, 0, 70)));

        // Wage normalization: UI uses wageDollars, file stores wageThousandsRaw/wageRaw (thousands)
        const wageThousands = getNum(copy, "wageThousandsRaw", "wageRaw");
        const wageDollarsExisting = getNum(copy, "wageDollars");
        const dollars = clamp(wageDollarsExisting !== 0 ? wageDollarsExisting : wageThousands * 1000, 0, 300000);
        const thousands = clamp(Math.round(dollars / 1000), 0, 300);
        copy.wageDollars = dollars;
        Object.assign(copy, setNumPatch(copy, "wageThousandsRaw", "wageRaw", thousands));

        const skillKeys = [
          ["brawlingRaw", "brawling"],
          ["speedRaw", "speed"],
          ["technicalRaw", "technical"],
          ["stiffnessRaw", "stiffness"],
          ["sellingRaw", "selling"],
          ["overnessRaw", "overness"],
          ["charismaRaw", "charisma"],
          ["attitudeRaw", "attitude"],
          ["behaviourRaw", "behaviour"],
        ] as const;

        for (const [pref, fb] of skillKeys) {
          const v = getNum(copy, pref, fb);
          Object.assign(copy, setNumPatch(copy, pref, fb, clamp(v, 0, 100)));
        }

        const gender = getNum(copy, "genderRaw", "gender");
        if (gender === 65535) {
          Object.assign(copy, setNumPatch(copy, "divaRaw", "diva", 0));
        }

        return copy;
      });

      const outBytes = writeWrestlerDat(rawBytes, normalized as any);
      validateWrestlerDatBytes(outBytes);

      const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
      const bakPath = `${filePath}.${ts}.bak`;

      const alreadyBak = await exists(bakPath);
      if (!alreadyBak) await copyFile(filePath, bakPath);

      await writeFile(filePath, outBytes);
      setRawBytes(outBytes);

      setStatus(`Saved OK. Backup: ${bakPath}`);
    } catch (e: any) {
      console.error(e);
      setStatus(`Save failed: ${e?.message ?? String(e)}`);
    }
  }



  async function onImportWrestler() {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }

      const chosen = await open({
        multiple: false,
        filters: [{ name: "EWR wrestler.dat", extensions: ["dat"] }],
      });

      if (!chosen) return;

      const p = String(chosen);
      const bytes = await readFile(p);
      validateWrestlerDatBytes(bytes);

      const parsed = parseWrestlerDat(toArrayBuffer(bytes));
      const sorted = [...parsed].sort((a: any, b: any) =>
        String(a.fullName ?? "").toLowerCase().localeCompare(String(b.fullName ?? "").toLowerCase())
      );

      setImportSourcePath(p);
      setImportSourceBytes(bytes);
      setImportSourceWorkers(sorted);
      setImportSelection(new Set());
      setImportSearch("");
      setImportInfo("");
      setImportModalOpen(true);
    } catch (e: any) {
      console.error(e);
      setStatus(`Import load failed: ${e?.message ?? String(e)}`);
    }
  }


  // ---------- External Editing: CSV ----------
  const CSV_COLUMNS: { key: string; label?: string }[] = [
    // Requested header order (labels / Yes-No flags)
    { key: "recordNumber" },
    { key: "workerId" },
    { key: "fullName" },
    { key: "shortName" },
    { key: "photoName" },
    { key: "gender" },
    { key: "nationality" },
    { key: "birthMonth" },
    { key: "age" },
    { key: "weight" },
    { key: "speaks" },
    { key: "wage" },

    // Skills (0-100)
    { key: "brawling" },
    { key: "speed" },
    { key: "technical" },
    { key: "stiffness" },
    { key: "selling" },
    { key: "overness" },
    { key: "charisma" },
    { key: "attitude" },
    { key: "behaviour" },

    // Flags (Yes/No)
    { key: "highSpots" },
    { key: "superstarLook" },
    { key: "announcer" },
    { key: "shootingAbility" },
    { key: "diva" },
    { key: "booker" },
    { key: "fonzFactor" },
    { key: "menacing" },
    { key: "trainer" },

    // Finishers
    { key: "primaryFinisherName" },
    { key: "primaryFinisherType" },
    { key: "secondaryFinisherName" },
    { key: "secondaryFinisherType" },
  ];

  const mapGender = schema?.mappings?.gender as Record<string, string> | undefined;
  const mapNationality = schema?.mappings?.nationality as Record<string, string> | undefined;
  const mapBirthMonth = schema?.mappings?.birthMonth as Record<string, string> | undefined;
  const mapWeight = schema?.mappings?.weight as Record<string, string> | undefined;

  const revGender = useMemo(() => makeReverseMap(mapGender), [mapGender]);
  const revNationality = useMemo(() => makeReverseMap(mapNationality), [mapNationality]);
  const revBirthMonth = useMemo(() => makeReverseMap(mapBirthMonth), [mapBirthMonth]);
  const revWeight = useMemo(() => makeReverseMap(mapWeight), [mapWeight]);

  function labelFromMap(map: Record<string, string> | undefined, raw: number): string {
    if (!map) return "";
    return map[String(raw)] ?? "";
  }

  function lowByte(n: number): number {
    return (Number(n) & 0xff) >>> 0;
  }

  function skillToCsv(w: any, rawKey: string): number {
    return lowByte(getNum(w, rawKey));
  }

  function boolToCsv(v: any): string {
    return isTruthy16(v) ? "Yes" : "No";
  }

  async function onExportCsv() {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }

      const defaultName = filePath
        ? filePath.replace(/\.dat$/i, ".csv")
        : "wrestlers.csv";

      const outPath = await save({
        title: "Export CSV",
        defaultPath: defaultName,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });

      if (!outPath) return;

      const header = CSV_COLUMNS.map((c) => csvEscape(c.key)).join(",");
      const lines: string[] = [header];

      const sorted = [...workers].sort((a: any, b: any) => Number(a.index ?? 0) - Number(b.index ?? 0));

      for (const w of sorted as any[]) {
        const genderRaw = getNum(w, "genderRaw", "gender");
        const natRaw = lowByte(getNum(w, "nationalityRaw", "nationality"));
        const monthRaw = lowByte(getNum(w, "birthMonthRaw", "birthMonth"));
        const weightRaw = lowByte(getNum(w, "weightRaw", "weight"));
        const wageDollars =
          getNum(w, "wageDollars") || (getNum(w, "wageThousandsRaw") ? getNum(w, "wageThousandsRaw") * 1000 : 0);

        const pfType = decodeFinisherTypeFromABC(getNum(w, "pfTypeFlagA"), getNum(w, "pfTypeFlagB"), getNum(w, "pfTypeFlagC"));
        const sfType = decodeFinisherTypeFromABC(getNum(w, "sfTypeFlagA"), getNum(w, "sfTypeFlagB"), getNum(w, "sfTypeFlagC"));

        const rec: Record<string, any> = {
          recordNumber: getNum(w, "index"),
          workerId: getNum(w, "id"),
          fullName: getStr(w, "fullName"),
          shortName: getStr(w, "shortName"),
          gender: labelFromMap(mapGender, genderRaw) || (genderRaw === 65535 ? "Male" : "Female"),
          nationality: labelFromMap(mapNationality, natRaw),
          birthMonth: labelFromMap(mapBirthMonth, monthRaw),
          age: lowByte(getNum(w, "ageRaw", "age")),
          weight: labelFromMap(mapWeight, weightRaw),
          speaks: boolToCsv(getNum(w, "speaksRaw")),
          photoName: getStr(w, "photoName"),
          wage: wageDollars,

          brawling: skillToCsv(w, "brawlingRaw"),
          speed: skillToCsv(w, "speedRaw"),
          technical: skillToCsv(w, "technicalRaw"),
          stiffness: skillToCsv(w, "stiffnessRaw"),
          selling: skillToCsv(w, "sellingRaw"),
          overness: skillToCsv(w, "overnessRaw"),
          charisma: skillToCsv(w, "charismaRaw"),
          attitude: skillToCsv(w, "attitudeRaw"),
          behaviour: skillToCsv(w, "behaviourRaw"),

          // Flags (Yes/No)
          highSpots: boolToCsv(getNum(w, "highSpotsRaw")),

          superstarLook: boolToCsv(getNum(w, "superstarLookRaw")),
          menacing: boolToCsv(getNum(w, "menacingRaw")),
          fonzFactor: boolToCsv(getNum(w, "fonzFactorRaw")),
          trainer: boolToCsv(getNum(w, "trainerRaw")),
          announcer: boolToCsv(getNum(w, "announcerRaw")),
          booker: boolToCsv(getNum(w, "bookerRaw")),
          diva: boolToCsv(getNum(w, "divaRaw")),

          shootingAbility: boolToCsv(getNum(w, "shootingAbilityRaw")),

          primaryFinisherName: getStr(w, "primaryFinisherName"),
          primaryFinisherType: pfType,
          secondaryFinisherName: getStr(w, "secondaryFinisherName"),
          secondaryFinisherType: sfType,
        };

        const line = CSV_COLUMNS.map((c) => csvEscape(rec[c.key] ?? "")).join(",");
        lines.push(line);
      }

      await writeFile(outPath, new TextEncoder().encode(lines.join("\n")));
      setStatus(`Exported CSV: ${outPath}`);
      setExternalEditingOpen(false);
    } catch (e: any) {
      console.error(e);
      setStatus(`Export CSV failed: ${e?.message || e}`);
    }
  }

  function parseLabelOrNumber(v: string, rev: Record<string, number>): number | null {
    const s = (v ?? "").trim();
    if (!s) return null;
    const num = Number(s);
    if (Number.isFinite(num)) return num;
    const key = s.toLowerCase();
    if (key in rev) return rev[key];
    return null;
  }

  function parseSkill(v: string): number | null {
    const s = (v ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return Math.trunc(n);
  }

  async function onImportCsv() {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }

      const picked = await open({
        title: "Import CSV",
        multiple: false,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });

      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;

      const bytes = await readFile(path);
      const text = new TextDecoder().decode(bytes);
      const parsed = parseCsv(text);
      const rows = parsed.rows;


// ---- CSV header validation (strict) ----
const expectedHeaders = CSV_COLUMNS.map((c) => c.key);
const actualHeaders = parsed.headers.map((h) => String(h ?? "").trim());
const missingHeaders = expectedHeaders.filter((h) => !actualHeaders.includes(h));
const extraHeaders = actualHeaders.filter((h) => h && !expectedHeaders.includes(h));
const orderMismatch =
  missingHeaders.length === 0 &&
  extraHeaders.length === 0 &&
  (actualHeaders.length !== expectedHeaders.length ||
    actualHeaders.some((h, idx) => h !== expectedHeaders[idx]));

if (missingHeaders.length || extraHeaders.length || orderMismatch) {
  const parts: string[] = [];
  if (missingHeaders.length) parts.push(`Missing: ${missingHeaders.join(", ")}`);
  if (extraHeaders.length) parts.push(`Extra: ${extraHeaders.join(", ")}`);
  if (orderMismatch && !missingHeaders.length && !extraHeaders.length) parts.push("Column order mismatch.");
  parts.push(`Expected order: ${expectedHeaders.join(", ")}`);

  setCsvSourcePath(path);
  setCsvRowCount(rows.length);
  setCsvPlannedUpdates([]);
  setCsvPlannedNewRows([]);
  setCsvSkippedDuplicates([]);
  setCsvInvalidRows([{ row: 1, field: "header", message: `CSV header mismatch. ${parts.join(" ")}` }]);
  setCsvImportInfo(
    "CSV header mismatch — import blocked. Fix the header row to match the expected columns exactly."
  );
  setCsvModalOpen(true);
  setExternalEditingOpen(false);
  return;
}

      const byId = new Map<number, any>();
      const byIndex = new Map<number, any>();
      const nameSet = new Set<string>();
      for (const w of workers as any[]) {
        byId.set(Number(w.id), w);
        byIndex.set(Number(w.index), w);
        nameSet.add(String(w.fullName ?? "").trim().toLowerCase());
      }

      const errors: CsvRowError[] = [];
      const skipped: string[] = [];
      const updates: CsvUpdatePlan[] = [];
      const newRows: CsvNewRowPlan[] = [];

      // schema lengths
      const lenFull = (schema?.fields ?? []).find((f: any) => f.name === "fullName")?.length ?? 25;
      const lenShort = (schema?.fields ?? []).find((f: any) => f.name === "shortName")?.length ?? 10;
      const lenPhoto = (schema?.fields ?? []).find((f: any) => f.name === "photoName")?.length ?? 20;
      const lenFin = (schema?.fields ?? []).find((f: any) => f.name === "primaryFinisherName")?.length ?? 25;

      const FIN_TYPES = new Set(["Impact", "Submission", "Top Rope Standing", "Top Rope", "Ground", "Corner"]);

      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2; // header is row 1
        const r = rows[i];
        let rowBad = false;

        const rowErr = (field: string, message: string) => {
          errors.push({ row: rowNum, field, message });
          rowBad = true;
        };

        const fullName = (r.fullName ?? "").trim();
        if (!fullName) {
          rowErr("fullName", "FullName is required.");
          continue;
        }
        if (fullName.length > lenFull) {
          rowErr("fullName", `FullName too long (${fullName.length} > ${lenFull}).`);
          continue;
        }

        const workerIdVal = (r.workerId ?? "").trim();
        const recordNumVal = (r.recordNumber ?? "").trim();

        const workerId = workerIdVal ? Number(workerIdVal) : null;
        const recordNumber = recordNumVal ? Number(recordNumVal) : null;

        const matchById = workerId != null && Number.isFinite(workerId) ? byId.get(workerId) : undefined;
        const matchByIndex =
          !matchById && recordNumber != null && Number.isFinite(recordNumber) ? byIndex.get(recordNumber) : undefined;

        const matchByName =
          !matchById && !matchByIndex
            ? (workers as any[]).find((w) => String(w.fullName ?? "").trim().toLowerCase() === fullName.toLowerCase())
            : undefined;

        const target = matchById || matchByIndex || matchByName;

        const patch: any = {};

        // Strings (optional)
        const shortName = (r.shortName ?? "").trim();
        if (shortName && shortName.length > lenShort) rowErr("shortName", `ShortName too long (${shortName.length} > ${lenShort}).`);
        if (shortName) patch.shortName = shortName;

        const photoName = (r.photoName ?? "").trim();
        if (photoName && photoName.length > lenPhoto) rowErr("photoName", `PhotoName too long (${photoName.length} > ${lenPhoto}).`);
        if (photoName) patch.photoName = photoName;

        const pfName = (r.primaryFinisherName ?? "").trim();
        if (pfName && pfName.length > lenFin) rowErr("primaryFinisherName", `Primary finisher name too long (${pfName.length} > ${lenFin}).`);
        if (pfName) patch.primaryFinisherName = pfName;

        const sfName = (r.secondaryFinisherName ?? "").trim();
        if (sfName && sfName.length > lenFin) rowErr("secondaryFinisherName", `Secondary finisher name too long (${sfName.length} > ${lenFin}).`);
        if (sfName) patch.secondaryFinisherName = sfName;

        // Enums / numeric fields (labels)
        if ((r.gender ?? "").trim()) {
          const g = parseLabelOrNumber(r.gender, revGender);
          if (g == null || Number.isNaN(g)) rowErr("gender", `Invalid gender "${r.gender}".`);
          else patch.genderRaw = g;
        }

        if ((r.nationality ?? "").trim()) {
          const n = parseLabelOrNumber(r.nationality, revNationality);
          if (n == null || Number.isNaN(n)) rowErr("nationality", `Invalid nationality "${r.nationality}".`);
          else {
            patch.nationalityRaw = lowByte(n);
            patch.nationality = lowByte(n);
          }
        }

        if ((r.birthMonth ?? "").trim()) {
          const bm = parseLabelOrNumber(r.birthMonth, revBirthMonth);
          if (bm == null || Number.isNaN(bm)) rowErr("birthMonth", `Invalid birthMonth "${r.birthMonth}".`);
          else {
            patch.birthMonthRaw = lowByte(bm);
            patch.birthMonth = lowByte(bm);
          }
        }

        if ((r.weight ?? "").trim()) {
          const wv = parseLabelOrNumber(r.weight, revWeight);
          if (wv == null || Number.isNaN(wv)) rowErr("weight", `Invalid weight "${r.weight}".`);
          else {
            patch.weightRaw = lowByte(wv);
            patch.weight = lowByte(wv);
          }
        }

        if ((r.age ?? "").trim()) {
          const a = parseSkill(r.age);
          if (a == null) {
            // ignore
          } else if (Number.isNaN(a) || a < 0 || a > 70) rowErr("age", `Age must be 0-70.`);
          else {
            patch.ageRaw = lowByte(a);
            patch.age = lowByte(a);
          }
        }

        if ((r.wage ?? "").trim()) {
          const w = parseSkill(r.wage);
          if (w == null) {
            // ignore
          } else if (Number.isNaN(w) || w < 0 || w > 300000) rowErr("wage", `Wage must be 0-300000.`);
          else {
            patch.wageThousandsRaw = Math.trunc(w / 1000);
            patch.wageDollars = w;
          }
        }

        // speaks Yes/No
        if ((r.speaks ?? "").trim()) {
          const b = parseYesNo(r.speaks);
          if (b === null) rowErr("speaks", `Speaks must be Yes/No.`);
          else patch.speaksRaw = setBool16(b);
        }

        // Finisher types (labels)
        if ((r.primaryFinisherType ?? "").trim()) {
          const t = (r.primaryFinisherType ?? "").trim();
          if (!FIN_TYPES.has(t)) rowErr("primaryFinisherType", `Invalid primary finisher type "${t}".`);
          else {
            const enc = encodeFinisherTypeToABC(t);
            patch.pfTypeFlagA = enc.A;
            patch.pfTypeFlagB = enc.B;
            patch.pfTypeFlagC = enc.C;
          }
        }

        if ((r.secondaryFinisherType ?? "").trim()) {
          const t = (r.secondaryFinisherType ?? "").trim();
          if (!FIN_TYPES.has(t)) rowErr("secondaryFinisherType", `Invalid secondary finisher type "${t}".`);
          else {
            const enc = encodeFinisherTypeToABC(t);
            patch.sfTypeFlagA = enc.A;
            patch.sfTypeFlagB = enc.B;
            patch.sfTypeFlagC = enc.C;
          }
        }

        // Skills 0-100
        const skillMap: { col: string; raw: string }[] = [
          { col: "brawling", raw: "brawlingRaw" },
          { col: "speed", raw: "speedRaw" },
          { col: "technical", raw: "technicalRaw" },
          { col: "stiffness", raw: "stiffnessRaw" },
          { col: "selling", raw: "sellingRaw" },
          { col: "overness", raw: "overnessRaw" },
          { col: "charisma", raw: "charismaRaw" },
          { col: "attitude", raw: "attitudeRaw" },
          { col: "behaviour", raw: "behaviourRaw" },
        ];

        for (const sm of skillMap) {
          const val = (r as any)[sm.col];
          if (!val) continue;
          const n = parseSkill(val);
          if (n == null) continue;
          if (Number.isNaN(n) || n < 0 || n > 100) rowErr(sm.col, `${sm.col} must be 0-100.`);
          else patch[sm.raw] = n;
        }

        // Flags Yes/No
        const flagCols: { col: string; raw: string }[] = [
          { col: "highSpots", raw: "highSpotsRaw" },
          { col: "superstarLook", raw: "superstarLookRaw" },
          { col: "menacing", raw: "menacingRaw" },
          { col: "fonzFactor", raw: "fonzFactorRaw" },
          { col: "trainer", raw: "trainerRaw" },
          { col: "announcer", raw: "announcerRaw" },
          { col: "booker", raw: "bookerRaw" },
          { col: "diva", raw: "divaRaw" },
          { col: "shootingAbility", raw: "shootingAbilityRaw" },
        ];

        for (const fc of flagCols) {
          const val = (r as any)[fc.col];
          if (!val) continue;
          const b = parseYesNo(val);
          if (b === null) rowErr(fc.col, `${fc.col} must be Yes/No.`);
          else patch[fc.raw] = setBool16(b);
        }

        // fullName updates
        patch.fullName = fullName;

        // If diva is set and gender is explicitly male, mark invalid
        const explicitGender = (r.gender ?? "").trim() ? patch.genderRaw : undefined;
        if (patch.divaRaw === 65535 && explicitGender === 65535) {
          rowErr("diva", "Diva can only be Yes for Female workers.");
        }

        if (rowBad) continue;

        // Determine if new row or update
        if (target) {
          // Prevent renaming to collide with another worker
          const oldName = String(target.fullName ?? "").trim().toLowerCase();
          const newName = String(fullName).trim().toLowerCase();
          if (newName && newName !== oldName && nameSet.has(newName)) {
            errors.push({ row: rowNum, field: "fullName", message: `Cannot rename to "${fullName}" — name already exists.` });
            continue;
          }
          updates.push({ targetIndex: Number(target.index), patch });
        } else {
          // new worker: skip duplicates
          const key = fullName.toLowerCase();
          if (nameSet.has(key)) {
            skipped.push(fullName);
            continue;
          }
          newRows.push({ data: patch as any });
          nameSet.add(key); // reserve so same import file can't add dup twice
        }
      }

      setCsvSourcePath(path);
      setCsvRowCount(rows.length);
      setCsvPlannedUpdates(updates);
      setCsvPlannedNewRows(newRows);
      setCsvSkippedDuplicates(skipped);
      setCsvInvalidRows(errors);

      setCsvImportInfo(
        `Loaded ${rows.length} row(s): ${updates.length} update(s), ${newRows.length} new, ${skipped.length} skipped duplicates, ${errors.length} invalid row(s).`
      );

      setCsvModalOpen(true);
      setExternalEditingOpen(false);
    } catch (e: any) {
      console.error(e);
      setStatus(`Import CSV failed: ${e?.message || e}`);
    }
  }

  function closeCsvModal() {
    setCsvModalOpen(false);
    setCsvSourcePath("");
    setCsvRowCount(0);
    setCsvPlannedUpdates([]);
    setCsvPlannedNewRows([]);
    setCsvSkippedDuplicates([]);
    setCsvInvalidRows([]);
    setCsvImportInfo("");
  }

  function applyCsvImport() {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }

      const recordSize = schema?.recordSize ?? 307;
      const markerOffset = schema?.recordHeader?.marker?.offset ?? 0;
      const markerValue = schema?.recordHeader?.marker?.value ?? 52;

      // Build name set / maxId fresh at apply time
      const existingNameSet = new Set<string>();
      let maxId = 0;
      for (const w of workers as any[]) {
        existingNameSet.add(String(w.fullName ?? "").trim().toLowerCase());
        maxId = Math.max(maxId, Number(w.id ?? 0));
      }

      // Apply updates
      const updatesByIndex = new Map<number, Partial<Worker>>();
      for (const u of csvPlannedUpdates) updatesByIndex.set(u.targetIndex, u.patch);

      let nextWorkers: any[] = (workers as any[]).map((w) => {
        const p = updatesByIndex.get(Number(w.index));
        if (!p) return w;

        const copy: any = { ...w };

        // Skills: preserve high byte if existing
        const skillKeys = [
          "brawlingRaw",
          "technicalRaw",
          "speedRaw",
          "stiffnessRaw",
          "sellingRaw",
          "overnessRaw",
          "charismaRaw",
          "attitudeRaw",
          "behaviourRaw",
        ];
        for (const k of skillKeys) {
          if (k in p) {
            const n = Number((p as any)[k]);
            copy[k] = setLowByteU16(Number(copy[k] ?? 0), n);
          }
        }

        // Merge non-skill fields
        for (const [k, v] of Object.entries(p)) {
          if (skillKeys.includes(k)) continue;
          copy[k] = v as any;
        }

        // Enforce diva off for male
        const g = getNum(copy, "genderRaw", "gender");
        if (g === 65535) copy.divaRaw = 0;

        return copy;
      });

      // Add new workers (auto-assign)
      let nextBytes = new Uint8Array(rawBytes);
      let totalRecords = nextBytes.length / recordSize;

      const addedNames: string[] = [];
      for (const n of csvPlannedNewRows) {
        const data = n.data as any;
        const fullName = String(data.fullName ?? "").trim();
        if (!fullName) continue;

        const key = fullName.toLowerCase();
        if (existingNameSet.has(key)) continue; // safety

        const newIndex = totalRecords;
        totalRecords += 1;
        const newId = maxId + 1;
        maxId = newId;

        // build blank record bytes
        const rec = new Uint8Array(recordSize);
        rec.fill(0);
        rec[markerOffset] = markerValue & 0xff;
        setU16LE(rec, 1, newId);

        const photoField = (schema?.fields ?? []).find((f: any) => f.name === "photoName");
        if (photoField?.offset != null && photoField?.length) {
          const txt = "None";
          for (let i = 0; i < photoField.length; i++) {
            rec[photoField.offset + i] = i < txt.length ? txt.charCodeAt(i) : 0x20;
          }
        }

        stripEmploymentInRecordBytes(rec);

        nextBytes = concatByteArrays(nextBytes, rec);

        // create worker object
        const w: any = { index: newIndex, id: newId };

        // Apply provided fields
        // Default gender: Male if unspecified
        w.genderRaw = typeof data.genderRaw === "number" ? data.genderRaw : 65535;

        w.fullName = fullName;
        if (data.shortName) w.shortName = data.shortName;
        if (data.photoName) w.photoName = data.photoName;

        if (typeof data.nationalityRaw === "number") {
          w.nationalityRaw = lowByte(data.nationalityRaw);
          w.nationality = lowByte(data.nationalityRaw);
        }
        if (typeof data.birthMonthRaw === "number") {
          w.birthMonthRaw = lowByte(data.birthMonthRaw);
          w.birthMonth = lowByte(data.birthMonthRaw);
        }
        if (typeof data.weightRaw === "number") {
          w.weightRaw = lowByte(data.weightRaw);
          w.weight = lowByte(data.weightRaw);
        }
        if (typeof data.ageRaw === "number") {
          w.ageRaw = lowByte(data.ageRaw);
          w.age = lowByte(data.ageRaw);
        }
        if (typeof data.speaksRaw === "number") w.speaksRaw = data.speaksRaw;

        if (typeof data.wageThousandsRaw === "number") {
          w.wageThousandsRaw = data.wageThousandsRaw;
          w.wageDollars = data.wageDollars ?? data.wageThousandsRaw * 1000;
        }

        // Skills
        const skillKeys = [
          "brawlingRaw",
          "technicalRaw",
          "speedRaw",
          "stiffnessRaw",
          "sellingRaw",
          "overnessRaw",
          "charismaRaw",
          "attitudeRaw",
          "behaviourRaw",
        ];
        for (const k of skillKeys) {
          if (k in data) w[k] = Number(data[k]);
        }

        // Flags
        const flagKeys = ["superstarLookRaw", "menacingRaw", "fonzFactorRaw", "trainerRaw", "announcerRaw", "bookerRaw", "divaRaw"];
        for (const k of flagKeys) {
          if (k in data) w[k] = Number(data[k]);
        }

        // Finishers
        if (data.primaryFinisherName) w.primaryFinisherName = data.primaryFinisherName;
        if (data.secondaryFinisherName) w.secondaryFinisherName = data.secondaryFinisherName;

        if ("pfTypeFlagA" in data) w.pfTypeFlagA = data.pfTypeFlagA;
        if ("pfTypeFlagB" in data) w.pfTypeFlagB = data.pfTypeFlagB;
        if ("pfTypeFlagC" in data) w.pfTypeFlagC = data.pfTypeFlagC;

        if ("sfTypeFlagA" in data) w.sfTypeFlagA = data.sfTypeFlagA;
        if ("sfTypeFlagB" in data) w.sfTypeFlagB = data.sfTypeFlagB;
        if ("sfTypeFlagC" in data) w.sfTypeFlagC = data.sfTypeFlagC;

        // Enforce diva off for male
        if (w.genderRaw === 65535) w.divaRaw = 0;

        existingNameSet.add(key);
        addedNames.push(fullName);
        nextWorkers.push(w);
      }

      // Finally, re-index sort for UI stability
      nextWorkers = [...nextWorkers].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));

      setRawBytes(nextBytes);
      setWorkers(nextWorkers as any);

// ---- Post-import sanity check ----
const lenFull = (schema?.fields ?? []).find((f: any) => f.name === "fullName")?.length ?? 25;

const totalRecs = nextBytes.length / recordSize;
const recMisalign = nextBytes.length % recordSize !== 0;

let maxWorkerId = 0;
const nameCounts = new Map<string, number>();
const tooLongNames: string[] = [];
let badSkillCount = 0;

const skillRawKeys = [
  "brawlingRaw",
  "technicalRaw",
  "speedRaw",
  "stiffnessRaw",
  "sellingRaw",
  "overnessRaw",
  "charismaRaw",
  "attitudeRaw",
  "behaviourRaw",
];

for (const w of nextWorkers as any[]) {
  maxWorkerId = Math.max(maxWorkerId, Number(w.id ?? 0));
  const n = String(w.fullName ?? "").trim();
  const key = n.toLowerCase();
  if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  if (n && n.length > lenFull) tooLongNames.push(n);

  // detect any skills outside 0-100 (low-byte)
  for (const k of skillRawKeys) {
    const v = lowByte(getNum(w, k));
    if (v < 0 || v > 100) {
      badSkillCount++;
      break;
    }
  }
}

const duplicateNames = Array.from(nameCounts.entries())
  .filter(([, c]) => c > 1)
  .map(([k]) => k);

const sanity = `Sanity: records=${totalRecs}${recMisalign ? "(!)" : ""}, maxId=${maxWorkerId}, dupNames=${duplicateNames.length}, longNames=${tooLongNames.length}, badSkills=${badSkillCount}`;

setStatus(
  `CSV import applied: ${csvPlannedUpdates.length} update(s), ${addedNames.length} new, ${csvSkippedDuplicates.length} skipped duplicates, ${csvInvalidRows.length} invalid. ${sanity}`
);

closeCsvModal();

    } catch (e: any) {
      console.error(e);
      setStatus(`Apply CSV failed: ${e?.message || e}`);
    }
  }

  function toggleImportSelection(sourceIndex: number, checked: boolean) {
    setImportSelection((prev) => {
      const next = new Set(prev);
      if (checked) next.add(sourceIndex);
      else next.delete(sourceIndex);
      return next;
    });
  }

  function closeImportModal() {
    setImportModalOpen(false);
    setImportInfo("");
    setImportSelection(new Set());
    setImportSearch("");
    setImportSourceWorkers([]);
    setImportSourceBytes(null);
    setImportSourcePath("");
  }

  function commitImportSelected() {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }
      if (!importSourceBytes) {
        setImportInfo("No import file loaded.");
        return;
      }
      if (importSelection.size === 0) {
        setImportInfo("Select at least one worker to import.");
        return;
      }

      const recordSize = schema?.recordSize ?? 307;
      const markerOffset = schema?.recordHeader?.marker?.offset ?? 0;
      const markerValue = schema?.recordHeader?.marker?.value ?? 52;

      // Determine existing names (fullName only, case-insensitive)
      const existingNames = new Set(workers.map((w: any) => String(w.fullName ?? "").trim().toLowerCase()));

      let nextBytes = rawBytes;
      let maxId = workers.reduce((m: number, w: any) => Math.max(m, Number(w.id ?? 0)), 0);

      const importedWorkers: any[] = [];
      const skippedDupes: string[] = [];
      const skippedEmpty: string[] = [];

      const selected = importSourceWorkers.filter((w: any) => importSelection.has(w.index));
      for (const src of selected) {
        const name = String(src.fullName ?? "").trim();
        const key = name.toLowerCase();

        if (!name) {
          skippedEmpty.push(String(src.shortName ?? "(unnamed)").trim() || "(unnamed)");
          continue;
        }
        if (existingNames.has(key)) {
          skippedDupes.push(name);
          continue;
        }

        const totalRecordsNow = nextBytes.length / recordSize;
        const newIndex = totalRecordsNow;
        const newId = maxId + 1;
        maxId = newId;

        const srcStart = src.index * recordSize;
        const srcEnd = srcStart + recordSize;
        if (srcEnd > importSourceBytes.length) {
          skippedEmpty.push(`${name} (out of bounds)`);
          continue;
        }

        const rec = new Uint8Array(importSourceBytes.slice(srcStart, srcEnd));

        // reset marker + new ID
        rec[markerOffset] = markerValue & 0xff;
        setU16LE(rec, 1, newId);

        // remove employment, so imports don't come in "signed"
        stripEmploymentInRecordBytes(rec);

        nextBytes = concatBytes(nextBytes, rec);

        // Clone worker object and patch id/index
        const out: any = { ...src, index: newIndex, id: newId };
        importedWorkers.push(out);

        existingNames.add(key);
      }

      if (importedWorkers.length === 0) {
        const msg =
          skippedDupes.length || skippedEmpty.length
            ? `Nothing imported. Duplicates: ${skippedDupes.length}. Skipped: ${skippedEmpty.length}.`
            : "Nothing imported.";
        setImportInfo(msg);
        return;
      }

      setRawBytes(nextBytes);
      setWorkers((prev) => [...prev, ...importedWorkers]);
      setSelectedRecordIndex(importedWorkers[0].index);

      const dupeMsg = skippedDupes.length ? ` Skipped duplicates: ${skippedDupes.join(", ")}.` : "";
      const emptyMsg = skippedEmpty.length ? ` Skipped unnamed/bad: ${skippedEmpty.join(", ")}.` : "";
      setStatus(`Imported ${importedWorkers.length} worker(s).${dupeMsg}${emptyMsg} Click Save to write to disk.`);
      closeImportModal();
    } catch (e: any) {
      console.error(e);
      setImportInfo(`Import failed: ${e?.message ?? String(e)}`);
    }
  }


  function onAddNewWorker() {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }

      const recordSize = schema?.recordSize ?? 307;
      const markerOffset = schema?.recordHeader?.marker?.offset ?? 0;
      const markerValue = schema?.recordHeader?.marker?.value ?? 52;

      const totalRecords = rawBytes.length / recordSize;
      const newIndex = totalRecords;

      const maxId = workers.reduce((m: number, w: any) => Math.max(m, Number(w.id ?? 0)), 0);
      const newId = maxId + 1;

      const rec = new Uint8Array(recordSize);
      rec.fill(0);
      rec[markerOffset] = markerValue & 0xff;
      setU16LE(rec, 1, newId);

      const photoField = (schema?.fields ?? []).find((f: any) => f.name === "photoName");
      if (photoField?.offset != null && photoField?.length) {
        const txt = "None";
        for (let i = 0; i < photoField.length; i++) {
          rec[photoField.offset + i] = i < txt.length ? txt.charCodeAt(i) : 0x20;
        }
      }

      stripEmploymentInRecordBytes(rec);

      const nextBytes = concatBytes(rawBytes, rec);
      setRawBytes(nextBytes);

      const w: any = { index: newIndex, id: newId };
      for (const f of schema?.fields ?? []) {
        if (f.type === "ascii_fixed") w[f.name] = f.name === "photoName" ? "None" : "";
        else w[f.name] = 0;
      }

      w.birthMonth = 0;
      w.age = 0;
      w.weight = 72;
      w.wageDollars = 0;

      setWorkers((prev) => [...prev, w]);
      setSelectedRecordIndex(newIndex);
      setStatus(`Added new worker record #${newIndex} (ID ${newId}). Click Save to write to disk.`);
    } catch (e: any) {
      console.error(e);
      setStatus(`Add failed: ${e?.message ?? String(e)}`);
    }
  }

  function onCopyWorker(recordIndex: number) {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }

      const recordSize = schema?.recordSize ?? 307;
      const markerOffset = schema?.recordHeader?.marker?.offset ?? 0;
      const markerValue = schema?.recordHeader?.marker?.value ?? 52;

      const src = workers.find((w: any) => w.index === recordIndex);
      if (!src) return;

      const totalRecords = rawBytes.length / recordSize;
      const newIndex = totalRecords;

      const maxId = workers.reduce((m: number, w: any) => Math.max(m, Number(w.id ?? 0)), 0);
      const newId = maxId + 1;

      const srcStart = recordIndex * recordSize;
      const srcEnd = srcStart + recordSize;
      const rec = new Uint8Array(rawBytes.slice(srcStart, srcEnd));

      rec[markerOffset] = markerValue & 0xff;
      setU16LE(rec, 1, newId);

      stripEmploymentInRecordBytes(rec);

      const nextBytes = concatBytes(rawBytes, rec);
      setRawBytes(nextBytes);

      const out: any = { ...src, index: newIndex, id: newId };

      out.photoName = (() => {
        const s = String(out.photoName ?? "None");
        const base = stripImageExtension(s);
        const clean = sanitizeAndTruncatePhotoBase(base);
        return clean || "None";
      })();

      const existing = new Set(workers.map((w: any) => String(w.fullName ?? "").trim().toLowerCase()));
      const baseName = String(out.fullName ?? "").trim() || String(out.shortName ?? "").trim() || "New Worker";
      out.fullName = makeUniqueFullName(baseName, existing);

      setWorkers((prev) => [...prev, out]);
      setSelectedRecordIndex(newIndex);
      setStatus(`Copied worker to new record #${newIndex} (ID ${newId}). Employment cleared. Click Save to write.`);
    } catch (e: any) {
      console.error(e);
      setStatus(`Copy failed: ${e?.message ?? String(e)}`);
    }
  }

  function onDeleteWorker(recordIndex: number) {
    try {
      if (!rawBytes) return;

      const recordSize = schema?.recordSize ?? 307;
      const totalRecords = rawBytes.length / recordSize;
      if (recordIndex < 0 || recordIndex >= totalRecords) return;

      const start = recordIndex * recordSize;
      const end = start + recordSize;

      const nextBytes = sliceRemove(rawBytes, start, end);
      setRawBytes(nextBytes);

      const nextWorkers = workers
        .filter((w: any) => w.index !== recordIndex)
        .map((w: any) => {
          if (w.index > recordIndex) return { ...w, index: w.index - 1 };
          return w;
        });

      setWorkers(nextWorkers as any);

      const newTotal = nextBytes.length / recordSize;
      const nextSel = clamp(recordIndex, 0, Math.max(0, newTotal - 1));
      setSelectedRecordIndex(nextSel);

      setSelectedForDelete((prev) => {
        if (!prev.size) return prev;
        const next = new Set<number>();
        for (const idx of prev) {
          if (idx === recordIndex) continue;
          if (idx > recordIndex) next.add(idx - 1);
          else next.add(idx);
        }
        return next;
      });

      setStatus(`Deleted record #${recordIndex}. Click Save to write to disk.`);
    } catch (e: any) {
      console.error(e);
      setStatus(`Delete failed: ${e?.message ?? String(e)}`);
    }
  }

  function toggleMultiDelete() {
    setStatus("");
    setMultiDeleteMode((prev) => {
      const next = !prev;
      if (!next) setSelectedForDelete(new Set());
      return next;
    });
  }

  function toggleSelectedForDelete(recordIndex: number, checked: boolean) {
    setSelectedForDelete((prev) => {
      const next = new Set(prev);
      if (checked) next.add(recordIndex);
      else next.delete(recordIndex);
      return next;
    });
  }

  function commitMultiDelete() {
    try {
      if (!rawBytes) {
        setStatus("Load wrestler.dat first.");
        return;
      }
      if (!selectedForDelete.size) {
        setStatus("No workers selected for deletion.");
        return;
      }

      const recordSize = schema?.recordSize ?? 307;
      const indicesDesc = Array.from(selectedForDelete).sort((a, b) => b - a);

      const ok = window.confirm(
        `Delete ${indicesDesc.length} worker(s)? This cannot be undone (until you close without saving).`
      );
      if (!ok) return;

      let bytes = rawBytes;
      let nextWorkers = [...workers];

      for (const idx of indicesDesc) {
        const start = idx * recordSize;
        const end = start + recordSize;
        bytes = sliceRemove(bytes, start, end);

        nextWorkers = nextWorkers
          .filter((w: any) => w.index !== idx)
          .map((w: any) => {
            if (w.index > idx) return { ...w, index: w.index - 1 };
            return w;
          });
      }

      setRawBytes(bytes);
      setWorkers(nextWorkers as any);

      const newTotal = bytes.length / recordSize;
      const nextSel = clamp(selectedRecordIndex, 0, Math.max(0, newTotal - 1));
      setSelectedRecordIndex(nextSel);

      setSelectedForDelete(new Set());
      setMultiDeleteMode(false);

      setStatus(`Multi-deleted ${indicesDesc.length} record(s). Click Save to write to disk.`);
    } catch (e: any) {
      console.error(e);
      setStatus(`Multi-delete failed: ${e?.message ?? String(e)}`);
    }
  }

  const isMale = selectedWorker ? getNum(selectedWorker as any, "genderRaw", "gender") === 65535 : false;

  const headerTitle = selectedWorker
    ? `Editing: ${getStr(selectedWorker as any, "fullName") || getStr(selectedWorker as any, "shortName") || "Worker"}`
    : "No worker selected";

  // ---------- grid view derived rows ----------
  const gridRows = useMemo(() => {
    const q = gridSearch.trim().toLowerCase();
    let list = profileFilteredWorkers;

    if (q) {
      list = list.filter((w: any) => {
        const name = String(w.fullName ?? "").toLowerCase();
        const shortName = String(w.shortName ?? "").toLowerCase();
        const id = String(w.id ?? "");
        const idx = String(w.index ?? "");
        return name.includes(q) || shortName.includes(q) || id.includes(q) || idx.includes(q);
      });
    }

    function skillVal(w: any, key: GridSortKey): number {
      switch (key) {
        case "brawling":
          return getNum(w, "brawlingRaw", "brawling");
        case "speed":
          return getNum(w, "speedRaw", "speed");
        case "technical":
          return getNum(w, "technicalRaw", "technical");
        case "stiffness":
          return getNum(w, "stiffnessRaw", "stiffness");
        case "selling":
          return getNum(w, "sellingRaw", "selling");
        case "overness":
          return getNum(w, "overnessRaw", "overness");
        case "charisma":
          return getNum(w, "charismaRaw", "charisma");
        case "attitude":
          return getNum(w, "attitudeRaw", "attitude");
        case "behaviour":
          return getNum(w, "behaviourRaw", "behaviour");
        default:
          return 0;
      }
    }

    const dir = gridSort.dir === "asc" ? 1 : -1;
    const key = gridSort.key;

    const sorted = [...list].sort((a: any, b: any) => {
      let av: any;
      let bv: any;

      if (key === "index") {
        av = Number(a.index ?? 0);
        bv = Number(b.index ?? 0);
      } else if (key === "id") {
        av = Number(a.id ?? 0);
        bv = Number(b.id ?? 0);
      } else if (key === "fullName") {
        av = String(a.fullName ?? "").toLowerCase();
        bv = String(b.fullName ?? "").toLowerCase();
      } else if (key === "shortName") {
        av = String(a.shortName ?? "").toLowerCase();
        bv = String(b.shortName ?? "").toLowerCase();
      } else {
        av = skillVal(a, key);
        bv = skillVal(b, key);
      }

      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });

    return sorted;
  }, [profileFilteredWorkers, gridSearch, gridSort]);

  function toggleGridSort(key: GridSortKey) {
    setGridSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: "asc" };
    });
  }

  // ---------- grid list sizing ----------
  const { ref: gridWrapRef, size: gridWrapSize } = useElementSize<HTMLDivElement>();

  // Robust height fallback: some WebViews report 0 until after first paint.
  const gridWrapMeasuredHeight =
    gridWrapSize.height ||
    Math.floor(gridWrapRef.current?.getBoundingClientRect?.().height ?? 0) ||
    Math.floor(gridWrapRef.current?.clientHeight ?? 0);

  // ✅ IMPORTANT: do not fallback to a random constant here — only the MIN floor prevents "0" failures.
  const gridListHeight = Math.max(320, Math.floor(gridWrapMeasuredHeight || 0));
  const gridRenderWidth = Math.max(GRID_TOTAL_WIDTH, Math.floor(gridWrapSize.width || gridWrapRef.current?.clientWidth || 0));
  const GRID_TEMPLATE = `${GRID_COLUMNS.map((c) => `${c.width}px`).join(" ")} 1fr`;

  // Sync header/body horizontal scroll
  const gridHeaderScrollRef = useRef<HTMLDivElement | null>(null);
  const gridBodyScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSyncLock = useRef<"header" | "body" | null>(null);

  function syncScroll(from: "header" | "body") {
    if (scrollSyncLock.current && scrollSyncLock.current !== from) return;
    scrollSyncLock.current = from;

    const h = gridHeaderScrollRef.current;
    const b = gridBodyScrollRef.current;
    if (!h || !b) {
      scrollSyncLock.current = null;
      return;
    }

    if (from === "header") {
      if (b.scrollLeft !== h.scrollLeft) b.scrollLeft = h.scrollLeft;
    } else {
      if (h.scrollLeft !== b.scrollLeft) h.scrollLeft = b.scrollLeft;
    }

    queueMicrotask(() => {
      scrollSyncLock.current = null;
    });
  }

  // ---------- Spreadsheet-like navigation ----------
  const gridListRef = useRef<any>(null);

  function focusGridCell(rowPos: number, colPos: number, doScroll: boolean) {
    const r = clamp(rowPos, 0, Math.max(0, gridRows.length - 1));
    const c = clamp(colPos, 0, Math.max(0, GRID_EDIT_COL_COUNT - 1));

    const selector = `[data-grid-row="${r}"][data-grid-col="${c}"]`;
    const el = document.querySelector(selector) as HTMLInputElement | null;

    if (el) {
      el.focus();
      try {
        el.select?.();
      } catch {}
      return;
    }

    if (!doScroll) return;

    const api = gridListRef.current;
    if (api) {
      if (typeof api.scrollToRow === "function") api.scrollToRow(r);
      else if (typeof api.scrollToItem === "function") api.scrollToItem(r);
    }

    requestAnimationFrame(() => {
      const el2 = document.querySelector(selector) as HTMLInputElement | null;
      if (el2) {
        el2.focus();
        try {
          el2.select?.();
        } catch {}
      }
    });
  }

  function navFromCell(rowPos: number, colPos: number, req: GridNavRequest) {
    const rowMax = Math.max(0, gridRows.length - 1);
    const colMax = Math.max(0, GRID_EDIT_COL_COUNT - 1);

    let nextRow = rowPos;
    let nextCol = colPos;

    if (req.kind === "tab") {
      if (!req.shift) {
        if (nextCol < colMax) nextCol += 1;
        else {
          nextCol = 0;
          nextRow = clamp(nextRow + 1, 0, rowMax);
        }
      } else {
        if (nextCol > 0) nextCol -= 1;
        else {
          nextCol = colMax;
          nextRow = clamp(nextRow - 1, 0, rowMax);
        }
      }
    } else if (req.kind === "enter") {
      nextRow = clamp(req.shift ? nextRow - 1 : nextRow + 1, 0, rowMax);
    } else if (req.kind === "arrow") {
      if (req.key === "ArrowUp") nextRow = clamp(nextRow - 1, 0, rowMax);
      if (req.key === "ArrowDown") nextRow = clamp(nextRow + 1, 0, rowMax);
      if (req.key === "ArrowLeft") nextCol = clamp(nextCol - 1, 0, colMax);
      if (req.key === "ArrowRight") nextCol = clamp(nextCol + 1, 0, colMax);
    }

    focusGridCell(nextRow, nextCol, true);
  }

  // ---------- grid row renderer ----------
  type GridRowProps = RowComponentProps<{
    rows: any[];
    onOpenProfile: (recordIndex: number) => void;
    updateWorkerByIndex: (recordIndex: number, patch: Partial<Worker>) => void;
    onNav: (rowPos: number, colPos: number, req: GridNavRequest) => void;
  }>;

  const GridRow = ({ index, style, rows, onOpenProfile, updateWorkerByIndex, onNav }: GridRowProps) => {
    const w = rows[index];
    if (!w) return null;

    const recordIndex = Number(w.index ?? 0);

    const vBrawling = getNum(w, "brawlingRaw", "brawling");
    const vSpeed = getNum(w, "speedRaw", "speed");
    const vTechnical = getNum(w, "technicalRaw", "technical");
    const vStiffness = getNum(w, "stiffnessRaw", "stiffness");
    const vSelling = getNum(w, "sellingRaw", "selling");
    const vOverness = getNum(w, "overnessRaw", "overness");
    const vCharisma = getNum(w, "charismaRaw", "charisma");
    const vAttitude = getNum(w, "attitudeRaw", "attitude");
    const vBehaviour = getNum(w, "behaviourRaw", "behaviour");

    const rowBg = index % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.02)";

    const COL_FULL = 0;
    const COL_SHORT = 1;
    const COL_BRAWL = 2;
    const COL_SPEED = 3;
    const COL_TECH = 4;
    const COL_STIFF = 5;
    const COL_SELL = 6;
    const COL_OVER = 7;
    const COL_CHAR = 8;
    const COL_ATT = 9;
    const COL_BEH = 10;

    return (
      <div style={{ ...style, width: gridRenderWidth }}>
        <div
          style={{
            width: gridRenderWidth,
            display: "grid",
            gridTemplateColumns: GRID_TEMPLATE,
            gap: 0,
            alignItems: "center",
            padding: "8px 10px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            background: rowBg,
          }}
          onMouseDown={(e) => {
            const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
            if (tag === "input" || tag === "select" || tag === "button" || tag === "textarea") return;
            onOpenProfile(recordIndex);
          }}
          title="Click row (not the inputs) to open this worker in Profile Editor"
        >
          <div style={{ paddingRight: 10, fontWeight: 900, opacity: 0.95 }}>{recordIndex}</div>
          <div style={{ paddingRight: 10, fontWeight: 900, opacity: 0.95 }}>{Number(w.id ?? 0)}</div>

          <div style={{ paddingRight: 10 }}>
            <GridTextCell
              value={String(w.fullName ?? "")}
              maxLen={25}
              gridRowPos={index}
              gridColPos={COL_FULL}
              onNav={onNav}
              onCommit={(next) => updateWorkerByIndex(recordIndex, setStrPatch(w, "fullName", "fullName", next) as any)}
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridTextCell
              value={String(w.shortName ?? "")}
              maxLen={10}
              gridRowPos={index}
              gridColPos={COL_SHORT}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setStrPatch(w, "shortName", "shortName", next) as any)
              }
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vBrawling}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_BRAWL}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setNumPatch(w, "brawlingRaw", "brawling", next) as any)
              }
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vSpeed}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_SPEED}
              onNav={onNav}
              onCommit={(next) => updateWorkerByIndex(recordIndex, setNumPatch(w, "speedRaw", "speed", next) as any)}
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vTechnical}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_TECH}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setNumPatch(w, "technicalRaw", "technical", next) as any)
              }
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vStiffness}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_STIFF}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setNumPatch(w, "stiffnessRaw", "stiffness", next) as any)
              }
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vSelling}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_SELL}
              onNav={onNav}
              onCommit={(next) => updateWorkerByIndex(recordIndex, setNumPatch(w, "sellingRaw", "selling", next) as any)}
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vOverness}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_OVER}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setNumPatch(w, "overnessRaw", "overness", next) as any)
              }
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vCharisma}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_CHAR}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setNumPatch(w, "charismaRaw", "charisma", next) as any)
              }
            />
          </div>

          <div style={{ paddingRight: 10 }}>
            <GridNumberCell
              value={vAttitude}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_ATT}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setNumPatch(w, "attitudeRaw", "attitude", next) as any)
              }
            />
          </div>

          <div style={{ paddingRight: 0 }}>
            <GridNumberCell
              value={vBehaviour}
              min={0}
              max={100}
              gridRowPos={index}
              gridColPos={COL_BEH}
              onNav={onNav}
              onCommit={(next) =>
                updateWorkerByIndex(recordIndex, setNumPatch(w, "behaviourRaw", "behaviour", next) as any)
              }
            />
          </div>

          <div />
        </div>
      </div>
    );
  };

  function openProfileFromGrid(recordIndex: number) {
    setSelectedRecordIndex(recordIndex);
    setViewMode("profile");
    setStatus(`Opened Record #${recordIndex} in Profile editor.`);
  }

  // ---------- render ----------
  const renderFilterPanel = (onClose: () => void, compact?: boolean) => (
    <div className={"ewr-filterPanel" + (compact ? " ewr-filterPanelCompact" : "")}>
              <div className="ewr-filterHeaderRow">
                <div className="ewr-filterTitle">Filter options</div>
                <div className="ewr-filterHeaderActions">
                  <button
                    type="button"
                    className="ewr-button ewr-buttonSmall"
                    onClick={() => setShowAdvancedFilters((v) => !v)}
                  >
                    {showAdvancedFilters ? "Hide" : "Advanced"}
                  </button>
                  <button type="button" className="ewr-button ewr-buttonSmall ewr-buttonApply" onClick={onClose}>
                    Apply
                  </button>
                  <button type="button" className="ewr-button ewr-buttonSmall" onClick={onClose}>
                    Close
                  </button>
                </div>
              </div>

              <div className="ewr-filterGrid">
                <div className="ewr-field">
                  <div className="ewr-label">Nationality</div>
                  <select
                    className="ewr-input"
                    value={filterNationality}
                    onChange={(e) => setFilterNationality(e.target.value === "" ? "" : Number(e.target.value))}
                  >
                    <option value="">Any</option>
                    {nationalityOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Gender</div>
                  <select
                    className="ewr-input"
                    value={filterGender}
                    onChange={(e) => {
                      const v = e.target.value as GenderFilter;
                      setFilterGender(v);
                      if (v === "male") setFlagFilters((prev) => ({ ...prev, diva: "" }));
                    }}
                  >
                    <option value="">Any</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Birth month</div>
                  <select
                    className="ewr-input"
                    value={filterBirthMonth}
                    onChange={(e) => setFilterBirthMonth(e.target.value === "" ? "" : Number(e.target.value))}
                  >
                    <option value="">Any</option>
                    {birthMonthOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Weight class</div>
                  <select className="ewr-input" value={filterWeight} onChange={(e) => setFilterWeight(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">Any</option>
                    {weightOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Speaks</div>
                  <select className="ewr-input" value={filterSpeaks} onChange={(e) => setFilterSpeaks(e.target.value as any)}>
                    <option value="">Any</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Age</div>
                  <div className="ewr-filterInline">
                    <input className="ewr-input" type="number" inputMode="numeric" min={0} max={70} placeholder="Min" value={filterAgeMin} onChange={(e) => setFilterAgeMin(e.target.value)} />
                    <input className="ewr-input" type="number" inputMode="numeric" min={0} max={70} placeholder="Max" value={filterAgeMax} onChange={(e) => setFilterAgeMax(e.target.value)} />
                  </div>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Wage ($)</div>
                  <div className="ewr-filterInline">
                    <input className="ewr-input" type="number" inputMode="numeric" min={0} max={300000} step={1000} placeholder="Min" value={filterWageMin} onChange={(e) => setFilterWageMin(e.target.value)} />
                    <input className="ewr-input" type="number" inputMode="numeric" min={0} max={300000} step={1000} placeholder="Max" value={filterWageMax} onChange={(e) => setFilterWageMax(e.target.value)} />
                  </div>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Primary finisher type</div>
                  <select className="ewr-input" value={filterPrimaryFinisherType} onChange={(e) => setFilterPrimaryFinisherType(e.target.value)}>
                    <option value="">Any</option>
                    {finisherTypeOptions.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ewr-field">
                  <div className="ewr-label">Secondary finisher type</div>
                  <select className="ewr-input" value={filterSecondaryFinisherType} onChange={(e) => setFilterSecondaryFinisherType(e.target.value)}>
                    <option value="">Any</option>
                    {finisherTypeOptions.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="ewr-filterSkills">
                <div className="ewr-filterSubTitle">Skill ranges</div>

                {skillRangeFilters.map((f) => (
                  <div key={f.id} className="ewr-filterSkillRow">
                    <select className="ewr-input" style={{ width: 150 }} value={f.key} onChange={(e) => updateSkillRangeFilter(f.id, { key: e.target.value as any })}>
                      {SKILL_FILTER_META.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>

                    <input className="ewr-input" type="number" inputMode="numeric" min={0} max={100} placeholder="Min" value={f.min} onChange={(e) => updateSkillRangeFilter(f.id, { min: e.target.value })} style={{ width: 78 }} />
                    <input className="ewr-input" type="number" inputMode="numeric" min={0} max={100} placeholder="Max" value={f.max} onChange={(e) => updateSkillRangeFilter(f.id, { max: e.target.value })} style={{ width: 78 }} />

                    {showAdvancedFilters ? (
                      <button type="button" className="ewr-button ewr-buttonSmall" onClick={() => removeSkillRangeFilter(f.id)} disabled={skillRangeFilters.length === 1} title="Remove range">
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}

                {showAdvancedFilters ? (
                  <div className="ewr-filterActionsRow">
                    <button type="button" className="ewr-button ewr-buttonSmall" onClick={addSkillRangeFilter}>
                      + Add range
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="ewr-filterSection">
                <div className="ewr-filterSubTitle">Attributes / roles</div>

                {FLAG_FILTER_META.map((f) => {
                  const disabled = !!f.divaOnly && filterGender === "male";
                  return (
                    <div key={f.key} className="ewr-filterFlagRow">
                      <div className="ewr-filterFlagLabel">
                        {f.label}
                        {f.divaOnly ? <span className="ewr-filterTiny"> (female only)</span> : null}
                      </div>
                      <select
                        className="ewr-input"
                        value={flagFilters[f.key] ?? ""}
                        onChange={(e) => setFlagFilters((prev) => ({ ...prev, [f.key]: e.target.value as any }))}
                        disabled={disabled}
                        title={disabled ? "Diva filter requires Female or Any gender." : undefined}
                      >
                        <option value="">Any</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </div>
                  );
                })}
              </div>
              
    </div>
  );

  return (
    <div className="ewr-app">
      {/* LEFT PANEL */}
      <div className="ewr-panel ewr-left">
        <div className="ewr-panelHeader">
          <div className="ewr-leftTopRow" style={{ justifyContent: "space-between" }}>
            <img src={ewrLogo} alt="EWR .DAT file editor" style={{ height: 44, width: "auto", display: "block" }} />

            <div style={{ display: "flex", gap: 10 }}>
              <button className="ewr-button ewr-buttonBlue" onClick={onOpen}>
                <IconFolderOpen className="btnSvg" />
                Open File
              </button>

              <button
                className="ewr-button ewr-buttonGreen"
                onClick={onSave}
                disabled={!filePath || !workers.length || !rawBytes}
                style={!filePath || !workers.length || !rawBytes ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
              >
                <IconSave className="btnSvg" />
                Save File
              </button>
            </div>
          </div>

          <div className="ewr-divider" />
        </div>

        <div className="ewr-leftMiddle ewr-scroll">
          <div className="ewr-leftBody">
            <div className="ewr-leftSearchRow">
              <input
                className="ewr-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search (name / short / ID)"
              />
              <select
                className="ewr-input"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as any)}
                style={{ width: 150 }}
              >
                <option value="id">Sort: ID</option>
                <option value="name">Sort: Name</option>
              </select>
            </div>

            <div style={{ marginTop: 12 }} className="ewr-muted">
              Showing <span className="ewr-strong">{filteredWorkers.length}</span> of{" "}
              <span className="ewr-strong">{workers.length}</span>
            </div>
            <div className="ewr-filterToggleRow">
              <button
                type="button"
                className="ewr-button ewr-buttonSmall ewr-filterToggleBtn"
                onClick={() => setFiltersOpen((v) => !v)}
              >
                {filtersOpen ? "Hide Filters" : "Filters"}
                {activeFilterCount ? ` (${activeFilterCount})` : ""}
              </button>

              <div className="ewr-filterToggleActions">
                <button
                  type="button"
                  className="ewr-button ewr-buttonSmall"
                  onClick={clearAllFilters}
                  disabled={activeFilterCount === 0}
                >
                  Clear
                </button>
              </div>
            </div>

            {filtersOpen ? renderFilterPanel(() => setFiltersOpen(false)) : null}

          </div>

          <div style={{ padding: "0 14px 14px" }}>
          {filteredWorkers.map((w: any) => {
            const isSelected = selectedWorker && w.index === (selectedWorker as any).index;
            const displayName = String(w.fullName || w.shortName || "(no name)").trim();
            const checked = selectedForDelete.has(w.index);

            return (
              <div
                key={`${w.index}-${w.id}`}
                className={`ewr-workerRow ${isSelected ? "ewr-workerRowActive" : ""}`}
                onClick={() => {
                  setSelectedRecordIndex(w.index);
                  setPhotoWarn("");
                }}
              >
                <div className="ewr-workerRowInner" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {multiDeleteMode ? (
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => toggleSelectedForDelete(w.index, e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 18, height: 18 }}
                      title="Select for multi-delete"
                    />
                  ) : null}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ewr-workerName">{displayName}</div>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="ewr-iconBtn ewr-iconBtnBlue"
                      title="Copy worker"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCopyWorker(w.index);
                      }}
                      aria-label="Copy worker"
                    >
                      <IconCopy className="iconBtnSvg" />
                    </button>

                    <button
                      type="button"
                      className="ewr-iconBtn ewr-iconBtnRed"
                      title="Delete worker"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteWorker(w.index);
                      }}
                      aria-label="Delete worker"
                    >
                      <IconTrash className="iconBtnSvg" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </div>

        <div className="ewr-leftFooter">
          <div className="ewr-footerGrid">
            <button className="ewr-button" style={{ width: "100%", justifyContent: "center" }} onClick={onAddNewWorker}>
              <IconPlus className="btnSvg" />
              Add New Worker
            </button>

            <button
              className="ewr-button"
              style={{
                width: "100%",
                justifyContent: "center",
                background: multiDeleteMode && selectedForDelete.size > 0 ? "rgba(255,70,70,0.18)" : undefined,
                border: multiDeleteMode && selectedForDelete.size > 0 ? "1px solid rgba(255,70,70,0.60)" : undefined,
              }}
              onClick={() => {
                if (!multiDeleteMode) {
                  toggleMultiDelete();
                  setStatus("Multi-Delete mode enabled: tick workers to delete, then click Multi-Delete again to commit.");
                  return;
                }
                if (selectedForDelete.size === 0) {
                  toggleMultiDelete();
                  setStatus("Multi-Delete mode disabled.");
                  return;
                }
                commitMultiDelete();
              }}
              title={
                !multiDeleteMode
                  ? "Enable multi-delete selection"
                  : selectedForDelete.size > 0
                  ? "Click again to delete selected workers"
                  : "Disable multi-delete (no selection)"
              }
            >
              <IconChecklist className="btnSvg" />
              {multiDeleteMode
                ? selectedForDelete.size > 0
                  ? `Delete Selected (${selectedForDelete.size})`
                  : "Cancel Multi-Delete"
                : "Multi-Delete"}
            </button>

            <button className="ewr-button" style={{ width: "100%", justifyContent: "center" }} onClick={onImportWrestler}>
              <IconImport className="btnSvg" />
              Import Worker
            </button>

            <button
              className="ewr-button ewr-buttonYellow"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => setExternalEditingOpen((v) => !v)}
              title="Export / import CSV for external editing"
            >
              <IconGrid className="btnSvg" />
              External Editing
            </button>
          </div>

          {multiDeleteMode ? (
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                className="ewr-button ewr-buttonSmall"
                type="button"
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setSelectedForDelete(new Set(filteredWorkers.map((w: any) => w.index)))}
                title="Select all currently listed workers"
              >
                Select All
              </button>
              <button
                className="ewr-button ewr-buttonSmall"
                type="button"
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setSelectedForDelete(new Set())}
                title="Clear selection"
              >
                Select None
              </button>
            </div>
          ) : null}

          {externalEditingOpen ? (
            <div className="ewr-externalMenu">
              <button className="ewr-button ewr-buttonSmall" style={{ width: "100%", justifyContent: "center" }} onClick={onExportCsv}>
                Export CSV
              </button>
              <button className="ewr-button ewr-buttonSmall" style={{ width: "100%", justifyContent: "center" }} onClick={onImportCsv}>
                Import CSV
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="ewr-panel ewr-main">
        <div className="ewr-mainHeader">
          <div className="ewr-mainTitleBar">{headerTitle}</div>

          <div className="ewr-mainMetaRow">
            <div className="ewr-pillRow">
              <div className="ewr-pill">Category: Workers</div>
              <div className="ewr-pill">
                Loaded: <b>{workers.length}</b>
              </div>
              {selectedWorker ? (
                <div className="ewr-pill">
                  Record <b>#{(selectedWorker as any).index}</b> — ID <b>{(selectedWorker as any).id}</b>
                </div>
              ) : null}
            </div>

            <div className="ewr-pillRow">
              <div className="ewr-pill">{filePath ? "wrestler.dat loaded" : "No file loaded"}</div>
              {status ? <div className="ewr-pill">{status}</div> : null}
              <div className="ewr-pill">{viewMode === "profile" ? "Profile Editor" : "Skills Grid"}</div>
            </div>
          </div>
        </div>

        {/* ✅ IMPORTANT: body overflow differs per mode */}
        <div className={viewMode === "grid" ? "ewr-mainBody ewr-mainBodyGrid" : "ewr-mainBody ewr-mainBodyScroll"}>
          {!selectedWorker ? (
            <div className="ewr-muted">Open wrestler.dat to begin.</div>
          ) : viewMode === "grid" ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                minHeight: 0,
                flex: 1,
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button className="ewr-button" onClick={() => setViewMode("profile")} title="Back to Profile editor">
                  <IconBack className="btnSvg" />
                  Back to Profile
                </button>

                <div style={{ flex: 1, minWidth: 280 }}>
                  <input
                    className="ewr-input"
                    value={gridSearch}
                    onChange={(e) => setGridSearch(e.target.value)}
                    placeholder="Grid search (name / short / ID / record #)"
                  />
                </div>

                <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="ewr-button ewr-buttonSmall"
                    onClick={() => setGridFiltersOpen((v) => !v)}
                  >
                    {gridFiltersOpen ? "Hide Filters" : "Filters"}
                    {activeFilterCount ? ` (${activeFilterCount})` : ""}
                  </button>
                  <button
                    type="button"
                    className="ewr-button ewr-buttonSmall"
                    onClick={clearAllFilters}
                    disabled={activeFilterCount === 0}
                  >
                    Clear
                  </button>
                </div>

                <div className="ewr-muted" style={{ fontWeight: 900 }}>
                  Rows: <span className="ewr-strong">{gridRows.length}</span>
                </div>
              </div>

              {gridFiltersOpen ? renderFilterPanel(() => setGridFiltersOpen(false), true) : null}

              <div
                style={{
                  overflow: "hidden",
                  border: "1px solid rgba(255,255,255,0.10)",
                  borderRadius: 14,
                  background: "rgba(0,0,0,0.18)",
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  flex: 1,
                }}
              >
                {/* HEADER */}
                <div
                  ref={gridHeaderScrollRef}
                  onScroll={() => syncScroll("header")}
                  style={{
                    overflowX: "auto",
                    overflowY: "hidden",
                    borderBottom: "1px solid rgba(255,255,255,0.10)",
                  }}
                >
                  <div
                    style={{
                      width: gridRenderWidth,
                      display: "grid",
                      gridTemplateColumns: GRID_TEMPLATE,
                      gap: 0,
                      padding: "10px 10px",
                      position: "relative",
                    }}
                  >
                    {GRID_COLUMNS.map((col) => {
                      const active = gridSort.key === col.key;
                      const arrow = active ? (gridSort.dir === "asc" ? "▲" : "▼") : "";
                      return (
                        <button
                          key={col.key}
                          type="button"
                          onClick={() => toggleGridSort(col.key)}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            paddingRight: 10,
                            fontSize: 12,
                            fontWeight: 950,
                            letterSpacing: 0.2,
                            opacity: active ? 1 : 0.88,
                            color: "rgba(255,255,255,0.95)",
                          }}
                          title="Click to sort (click again toggles Asc/Desc)"
                        >
                          {col.label} {arrow}
                        </button>
                      );
                    })}

                    <div />
                  </div>
                </div>

                {/* BODY */}
                <div
                  ref={gridWrapRef}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    width: "100%",
                  }}
                >
                  <div
                    ref={gridBodyScrollRef}
                    onScroll={() => syncScroll("body")}
                    style={{
                      height: "100%",
                      overflowX: "auto",
                      overflowY: "hidden",
                    }}
                  >
                    <VirtualList
                      key={`grid-${gridRows.length}-${gridListHeight}-${gridRenderWidth}`}
                      ref={gridListRef}
                      rowComponent={GridRow}
                      rowCount={gridRows.length}
                      rowHeight={54}
                      rowProps={{
                        rows: gridRows,
                        onOpenProfile: openProfileFromGrid,
                        updateWorkerByIndex,
                        onNav: navFromCell,
                      }}
                      overscanCount={8}
                      defaultHeight={gridListHeight}
                      style={{
                        height: gridListHeight,
                        width: gridRenderWidth,
                      }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ marginTop: "auto" }} className="ewr-hint">
                Tip: Tab/Shift+Tab moves across cells. Enter/Shift+Enter moves up/down. Ctrl/Cmd + arrows navigates
                cells.
              </div>
            </div>
          ) : (
            <>
              <h2 className="ewr-h2">
                {getStr(selectedWorker as any, "fullName") || getStr(selectedWorker as any, "shortName") || "Worker"}
              </h2>
              <div className="ewr-subtitle">
                Record #{(selectedWorker as any).index} — Worker ID {(selectedWorker as any).id}
              </div>

              {/* IDENTITY */}
              <div className="ewr-section">
                <div className="ewr-sectionHeader">
                  <div className="ewr-sectionTitle">Identity</div>
                </div>
                <div className="ewr-sectionBody">
                  <div className="ewr-grid ewr-gridAuto">
                    <div className="ewr-field">
                      <div className="ewr-label">Full Name (25)</div>
                      <input
                        className="ewr-input"
                        value={getStr(selectedWorker as any, "fullName")}
                        maxLength={25}
                        onChange={(e) =>
                          updateSelected(setStrPatch(selectedWorker as any, "fullName", "fullName", e.target.value) as any)
                        }
                      />
                    </div>

                    <div className="ewr-field">
                      <div className="ewr-label">Short Name (10)</div>
                      <input
                        className="ewr-input"
                        value={getStr(selectedWorker as any, "shortName")}
                        maxLength={10}
                        onChange={(e) =>
                          updateSelected(
                            setStrPatch(selectedWorker as any, "shortName", "shortName", e.target.value) as any
                          )
                        }
                      />
                    </div>

                    <div className="ewr-field">
                      <div className="ewr-label">Gender</div>
                      <select
                        className="ewr-input"
                        value={isMale ? "Male" : "Female"}
                        onChange={(e) => {
                          const next = e.target.value === "Male" ? 65535 : 0;
                          const patch: any = setNumPatch(selectedWorker as any, "genderRaw", "gender", next);
                          if (next === 65535) Object.assign(patch, setNumPatch(selectedWorker as any, "divaRaw", "diva", 0));
                          updateSelected(patch);
                        }}
                      >
                        <option value="Female">Female</option>
                        <option value="Male">Male</option>
                      </select>
                    </div>

                    <div className="ewr-field">
                      <div className="ewr-label">Birth Month</div>
                      <select
                        className="ewr-input"
                        value={getNum(selectedWorker as any, "birthMonthRaw", "birthMonth") & 0xff}
                        onChange={(e) => {
                          const v = Number(e.target.value) & 0xff;
                          const oldRaw = getNum(selectedWorker as any, "birthMonthRaw", "birthMonth");
                          updateSelected(
                            setNumPatch(
                              selectedWorker as any,
                              "birthMonthRaw",
                              "birthMonth",
                              setLowByteU16(oldRaw, v)
                            ) as any
                          );
                        }}
                      >
                        {birthMonthOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="ewr-field">
                      <div className="ewr-label">Age (0–70)</div>
                      <NumberInput
                        className="ewr-input"
                        value={getNum(selectedWorker as any, "ageRaw", "age")}
                        min={0}
                        max={70}
                        step={1}
                        onChange={(next) => updateSelected(setNumPatch(selectedWorker as any, "ageRaw", "age", next) as any)}
                      />
                    </div>

                    <div className="ewr-field">
                      <div className="ewr-label">Weight</div>
                      <select
                        className="ewr-input"
                        value={getNum(selectedWorker as any, "weightRaw", "weight") & 0xff}
                        onChange={(e) => {
                          const v = Number(e.target.value) & 0xff;
                          const oldRaw = getNum(selectedWorker as any, "weightRaw", "weight");
                          updateSelected(
                            setNumPatch(selectedWorker as any, "weightRaw", "weight", setLowByteU16(oldRaw, v)) as any
                          );
                        }}
                      >
                        {weightOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="ewr-field">
                      <div className="ewr-label">Nationality</div>
                      <select
                        className="ewr-input"
                        value={getNum(selectedWorker as any, "nationalityRaw", "nationality") & 0xff}
                        onChange={(e) =>
                          updateSelected(
                            setNumPatch(
                              selectedWorker as any,
                              "nationalityRaw",
                              "nationality",
                              Number(e.target.value) & 0xff
                            ) as any
                          )
                        }
                      >
                        {nationalityOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="ewr-field" style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 22 }}>
                      <input
                        type="checkbox"
                        checked={isTruthy16(getNum(selectedWorker as any, "speaksRaw", "speaks"))}
                        onChange={(e) =>
                          updateSelected(
                            setNumPatch(selectedWorker as any, "speaksRaw", "speaks", setBool16(e.target.checked)) as any
                          )
                        }
                      />
                      <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 900 }}>Speaks</div>
                    </div>

                    <div className="ewr-field" style={{ gridColumn: "1 / -1" }}>
                      <div className="ewr-label">Profile Photo Name (20)</div>

                      <div className="ewr-photoRow">
                        <input
                          className="ewr-input"
                          value={getStr(selectedWorker as any, "photoName")}
                          maxLength={20}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const cleaned = sanitizeAndTruncatePhotoBase(stripImageExtension(raw));
                            updateSelected(setStrPatch(selectedWorker as any, "photoName", "photoName", cleaned) as any);
                            setPhotoWarn(computePhotoWarn(raw));
                          }}
                        />

                        <button
                          type="button"
                          className="ewr-button"
                          onClick={() => {
                            const full = getStr(selectedWorker as any, "fullName").trim();
                            if (!full) {
                              setStatus("Full Name is empty — cannot set photo name from it.");
                              return;
                            }
                            const cleaned = sanitizeAndTruncatePhotoBase(full);
                            updateSelected(setStrPatch(selectedWorker as any, "photoName", "photoName", cleaned) as any);
                            setPhotoWarn(computePhotoWarn(full));
                            setStatus("Photo Name set to Full Name (Worker Name).");
                          }}
                        >
                          Set as Worker Name
                        </button>

                        <button
                          type="button"
                          className="ewr-button"
                          onClick={() => {
                            const full = getStr(selectedWorker as any, "fullName");
                            const underscored = fullNameToUnderscore(full);
                            if (!underscored) {
                              setStatus("Full Name is empty — cannot set photo name from it.");
                              return;
                            }
                            const cleaned = sanitizeAndTruncatePhotoBase(underscored);
                            updateSelected(setStrPatch(selectedWorker as any, "photoName", "photoName", cleaned) as any);
                            setPhotoWarn(computePhotoWarn(underscored));
                            setStatus("Photo Name set to Full Name with underscores (Worker_Name).");
                          }}
                        >
                          Set as Worker_Name
                        </button>
                      </div>

                      {photoWarn ? (
                        <div className="ewr-warn">{photoWarn}</div>
                      ) : (
                        <div className="ewr-hint">
                          Base name only. If empty or “None”, native writes <b>None</b> (no .jpg). Otherwise “.jpg” is
                          appended on Save.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* WAGE (separate section, like the old working version) */}
              <div className="ewr-section">
                <div className="ewr-sectionHeader">
                  <div className="ewr-sectionTitle">Wage</div>
                </div>
                <div className="ewr-sectionBody">
                  <div style={{ maxWidth: 420 }}>
                    <div className="ewr-label">Wage ($) (0–300000)</div>
                    <NumberInput
                      className="ewr-input"
                      value={Number(
                        (selectedWorker as any).wageDollars ??
                          getNum(selectedWorker as any, "wageThousandsRaw", "wageRaw") * 1000
                      )}
                      min={0}
                      max={300000}
                      step={1000}
                      onChange={(next) => {
                        const dollars = clamp(next, 0, 300000);
                        const thousands = clamp(Math.round(dollars / 1000), 0, 300);
                        updateSelected({
                          wageDollars: dollars,
                          ...setNumPatch(selectedWorker as any, "wageThousandsRaw", "wageRaw", thousands),
                        } as any);
                      }}
                    />
                    <div className="ewr-hint">
                      Note: EWR stores wage in <b>$1000</b> units internally.
                    </div>
                  </div>
                </div>
              </div>

              {/* SKILLS (with Skills Grid button in-header, like the old version) */}
              {/* NOTE: overflow visible so the compare dropdown can render over the next section */}
              <div className="ewr-section ewr-sectionOverflowVisible">
                <div
                  className="ewr-sectionHeader"
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                >
                  <div className="ewr-sectionTitle">Skills</div>

                  <button
                    type="button"
                    className="ewr-button"
                    onClick={() => {
                      setViewMode("grid");
                      setStatus("Opened Skills Grid for bulk balancing.");
                    }}
                    title="Open the comparative skills grid"
                    style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                  >
                    <IconGrid className="btnSvg" />
                    Open Skills Grid
                  </button>
                </div>

                <div className="ewr-sectionBody">
                  <div className="ewr-grid ewr-gridAuto">
                    {[
                      ["Brawling", "brawlingRaw", "brawling"],
                      ["Speed", "speedRaw", "speed"],
                      ["Technical", "technicalRaw", "technical"],
                      ["Stiffness", "stiffnessRaw", "stiffness"],
                      ["Selling", "sellingRaw", "selling"],
                      ["Overness", "overnessRaw", "overness"],
                      ["Charisma", "charismaRaw", "charisma"],
                      ["Attitude", "attitudeRaw", "attitude"],
                      ["Behaviour", "behaviourRaw", "behaviour"],
                    ].map(([label, pref, fb]) => (
                      <div className="ewr-field" key={label}>
                        <div className="ewr-label">{label} (0–100)</div>
                        <NumberInput
                          className="ewr-input"
                          value={getNum(selectedWorker as any, pref, fb)}
                          min={0}
                          max={100}
                          step={1}
                          onChange={(next) =>
                            updateSelected(setNumPatch(selectedWorker as any, pref, fb, next) as any)
                          }
                        />
                      </div>
                    ))}
                  </div>

                  {/* Compare skills */}
                  <div className="ewr-compareBlock">
                    <div className="ewr-compareRow">
                      <div className="ewr-compareLabel">Compare to the Skills of</div>
                      <div className="ewr-compareCombo">
                      <input
                        ref={compareInputRef}
                        className="ewr-input ewr-compareInput"
                        value={compareInput}
                        onFocus={() => {
                          setCompareOpen(true);
                          setCompareActive(0);
                        }}
                        onBlur={() => {
                          // delay so option clicks (mouseDown) can run before close
                          window.setTimeout(() => setCompareOpen(false), 120);
                        }}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCompareInput(v);
                          setCompareOpen(true);
                          setCompareActive(0);

                          const norm = String(v ?? "").trim();
                          if (!norm || norm.toLowerCase() === "none") {
                            setCompareRecordIndex(null);
                            return;
                          }
                          const idx = compareCatalog.map.get(norm.toLowerCase());
                          setCompareRecordIndex(idx ?? null);
                        }}
                        onKeyDown={(e) => {
                          const names = getCompareFilteredNames();
                          if (!compareOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                            setCompareOpen(true);
                            return;
                          }
                          if (e.key === "Escape") {
                            setCompareOpen(false);
                            return;
                          }
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setCompareActive((i) => Math.min(i + 1, Math.max(0, names.length - 1)));
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setCompareActive((i) => Math.max(i - 1, 0));
                            return;
                          }
                          if (e.key === "Enter") {
                            if (compareOpen && names.length) {
                              e.preventDefault();
                              const picked = names[Math.min(compareActive, names.length - 1)];
                              applyCompareName(picked);
                            } else {
                              applyCompareName(compareInput);
                            }
                          }
                        }}
                      />

                      {compareOpen ? (
                        <div className="ewr-compareDropdown">
                          {getCompareFilteredNames().map((name, i) => (
                            <div
                              key={name}
                              className={"ewr-compareOption" + (i === compareActive ? " isActive" : "")}
                              onMouseDown={(ev) => {
                                ev.preventDefault();
                                applyCompareName(name);
                              }}
                              onMouseEnter={() => setCompareActive(i)}
                            >
                              {name}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    </div>

                    {compareWorker ? (
                      <div className="ewr-comparePanel">
                        <div className="ewr-comparePanelTitle">
                          Compared worker: <b>{getStr(compareWorker as any, "fullName")}</b>
                        </div>
                        <div className="ewr-grid ewr-gridAuto">
                          {[
                            ["Brawling", "brawlingRaw", "brawling"],
                            ["Speed", "speedRaw", "speed"],
                            ["Technical", "technicalRaw", "technical"],
                            ["Stiffness", "stiffnessRaw", "stiffness"],
                            ["Selling", "sellingRaw", "selling"],
                            ["Overness", "overnessRaw", "overness"],
                            ["Charisma", "charismaRaw", "charisma"],
                            ["Attitude", "attitudeRaw", "attitude"],
                            ["Behaviour", "behaviourRaw", "behaviour"],
                          ].map(([label, pref, fb]) => {
                            const cur = getNum(selectedWorker as any, pref, fb);
                            const cmp = getNum(compareWorker as any, pref, fb);
                            const delta = cur - cmp;
                            const deltaText = delta > 0 ? `+${delta}` : String(delta);
                            return (
                              <div className="ewr-field" key={`cmp-${label}`}>
                                <div className="ewr-label">{label}</div>
                                <div className="ewr-compareStat">
                                  <span className="ewr-compareValue">{cmp}</span>
                                  <span className="ewr-compareDelta" data-sign={delta === 0 ? "zero" : delta > 0 ? "pos" : "neg"}>
                                    Δ {deltaText}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* ATTRIBUTES / FLAGS (restored: not just Diva) */}
              <div className="ewr-section">
                <div className="ewr-sectionHeader">
                  <div className="ewr-sectionTitle">Attributes / Flags</div>
                </div>
                <div className="ewr-sectionBody">
                  <div className="ewr-grid ewr-gridAuto">
                    {[
                      ["Superstar Look", "superstarLookRaw", "superstarLook"],
                      ["Menacing", "menacingRaw", "menacing"],
                      ["Fonz Factor", "fonzFactorRaw", "fonzFactor"],
                      ["High Spots", "highSpotsRaw", "highSpots"],
                      ["Shooting Ability", "shootingAbilityRaw", "shootingAbility"],
                      ["Trainer", "trainerRaw", "trainer"],
                      ["Announcer", "announcerRaw", "announcer"],
                      ["Booker", "bookerRaw", "booker"],
                    ]
                      .filter(([, pref, fb]) => hasKey(selectedWorker as any, pref) || hasKey(selectedWorker as any, fb))
                      .map(([label, pref, fb]) => {
                        const checked = isTruthy16(getNum(selectedWorker as any, pref, fb));
                        return (
                          <label
                            key={label}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "10px 12px",
                              borderRadius: 12,
                              border: "1px solid rgba(255,255,255,0.10)",
                              background: "rgba(14,18,28,0.72)",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                updateSelected(
                                  setNumPatch(selectedWorker as any, pref, fb, setBool16(e.target.checked)) as any
                                )
                              }
                            />
                            <span style={{ fontSize: 13, opacity: 0.92, fontWeight: 900 }}>{label}</span>
                          </label>
                        );
                      })}

                    {/* Diva (female only) */}
                    {(hasKey(selectedWorker as any, "divaRaw") || hasKey(selectedWorker as any, "diva")) && (
                      <label
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          padding: "10px 12px",
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.10)",
                          background: "rgba(14,18,28,0.72)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <input
                            type="checkbox"
                            checked={isTruthy16(getNum(selectedWorker as any, "divaRaw", "diva"))}
                            disabled={isMale}
                            onChange={(e) =>
                              updateSelected(
                                setNumPatch(selectedWorker as any, "divaRaw", "diva", setBool16(e.target.checked)) as any
                              )
                            }
                          />
                          <span style={{ fontSize: 13, opacity: 0.92, fontWeight: 900 }}>Diva (female only)</span>
                        </div>

                        {isMale ? (
                          <div style={{ fontSize: 12, fontWeight: 950, color: "#ff4d4d" }}>
                            Disabled because Gender is Male.
                          </div>
                        ) : null}
                      </label>
                    )}
                  </div>
                </div>
              </div>

              {/* FINISHERS (supports old primary/secondary keys OR the newer generic keys) */}
              {(() => {
                const hasPrimary =
                  hasKey(selectedWorker as any, "primaryFinisherName") ||
                  hasKey(selectedWorker as any, "pfName") ||
                  hasKey(selectedWorker as any, "pfTypeFlagA") ||
                  hasKey(selectedWorker as any, "primaryFinisherTypeFlagA");

                const hasSecondary =
                  hasKey(selectedWorker as any, "secondaryFinisherName") ||
                  hasKey(selectedWorker as any, "sfName") ||
                  hasKey(selectedWorker as any, "sfTypeFlagA") ||
                  hasKey(selectedWorker as any, "secondaryFinisherTypeFlagA");

                // Generic fallback (your newer defensive keys)
                const nameKey =
                  hasKey(selectedWorker, "finisherName")
                    ? "finisherName"
                    : hasKey(selectedWorker, "finisher")
                    ? "finisher"
                    : hasKey(selectedWorker, "finisherMove")
                    ? "finisherMove"
                    : null;

                const AKey =
                  hasKey(selectedWorker, "finisherARaw")
                    ? "finisherARaw"
                    : hasKey(selectedWorker, "finisherA")
                    ? "finisherA"
                    : null;

                const BKey =
                  hasKey(selectedWorker, "finisherBRaw")
                    ? "finisherBRaw"
                    : hasKey(selectedWorker, "finisherB")
                    ? "finisherB"
                    : null;

                const CKey =
                  hasKey(selectedWorker, "finisherCRaw")
                    ? "finisherCRaw"
                    : hasKey(selectedWorker, "finisherC")
                    ? "finisherC"
                    : null;

                const shouldRender = hasPrimary || hasSecondary || nameKey || (AKey && BKey && CKey);
                if (!shouldRender) return null;

                return (
                  <div className="ewr-section">
                    <div className="ewr-sectionHeader">
                      <div className="ewr-sectionTitle">Finishers</div>
                    </div>

                    <div className="ewr-sectionBody">
                      {/* Old schema layout (primary/secondary) */}
                      {hasPrimary || hasSecondary ? (
                        <div className="ewr-grid" style={{ gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
                          {hasPrimary ? (
                            <>
                              <div className="ewr-field">
                                <div className="ewr-label">Primary Finisher Name (25)</div>
                                <input
                                  className="ewr-input"
                                  value={getStr(selectedWorker as any, "primaryFinisherName", "pfName")}
                                  maxLength={25}
                                  onChange={(e) =>
                                    updateSelected(
                                      setStrPatch(
                                        selectedWorker as any,
                                        hasKey(selectedWorker as any, "primaryFinisherName")
                                          ? "primaryFinisherName"
                                          : "pfName",
                                        hasKey(selectedWorker as any, "primaryFinisherName")
                                          ? "primaryFinisherName"
                                          : "pfName",
                                        e.target.value
                                      ) as any
                                    )
                                  }
                                />
                              </div>

                              <div className="ewr-field">
                                <div className="ewr-label">Primary Finisher Type</div>
                                <select
                                  className="ewr-input"
                                  value={decodeFinisherTypeFromABC(
                                    getNum(selectedWorker as any, "pfTypeFlagA", "primaryFinisherTypeFlagA"),
                                    getNum(selectedWorker as any, "pfTypeFlagB", "primaryFinisherTypeFlagB"),
                                    getNum(selectedWorker as any, "pfTypeFlagC", "primaryFinisherTypeFlagC")
                                  )}
                                  onChange={(e) => {
                                    const next = encodeFinisherTypeToABC(e.target.value);
                                    updateSelected({
                                      ...setNumPatch(
                                        selectedWorker as any,
                                        "pfTypeFlagA",
                                        "primaryFinisherTypeFlagA",
                                        next.A
                                      ),
                                      ...setNumPatch(
                                        selectedWorker as any,
                                        "pfTypeFlagB",
                                        "primaryFinisherTypeFlagB",
                                        next.B
                                      ),
                                      ...setNumPatch(
                                        selectedWorker as any,
                                        "pfTypeFlagC",
                                        "primaryFinisherTypeFlagC",
                                        next.C
                                      ),
                                    } as any);
                                  }}
                                >
                                  {finisherTypeOptions.map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </>
                          ) : null}

                          {hasSecondary ? (
                            <>
                              <div className="ewr-field">
                                <div className="ewr-label">Secondary Finisher Name (25)</div>
                                <input
                                  className="ewr-input"
                                  value={getStr(selectedWorker as any, "secondaryFinisherName", "sfName")}
                                  maxLength={25}
                                  onChange={(e) =>
                                    updateSelected(
                                      setStrPatch(
                                        selectedWorker as any,
                                        hasKey(selectedWorker as any, "secondaryFinisherName")
                                          ? "secondaryFinisherName"
                                          : "sfName",
                                        hasKey(selectedWorker as any, "secondaryFinisherName")
                                          ? "secondaryFinisherName"
                                          : "sfName",
                                        e.target.value
                                      ) as any
                                    )
                                  }
                                />
                              </div>

                              <div className="ewr-field">
                                <div className="ewr-label">Secondary Finisher Type</div>
                                <select
                                  className="ewr-input"
                                  value={decodeFinisherTypeFromABC(
                                    getNum(selectedWorker as any, "sfTypeFlagA", "secondaryFinisherTypeFlagA"),
                                    getNum(selectedWorker as any, "sfTypeFlagB", "secondaryFinisherTypeFlagB"),
                                    getNum(selectedWorker as any, "sfTypeFlagC", "secondaryFinisherTypeFlagC")
                                  )}
                                  onChange={(e) => {
                                    const next = encodeFinisherTypeToABC(e.target.value);
                                    updateSelected({
                                      ...setNumPatch(
                                        selectedWorker as any,
                                        "sfTypeFlagA",
                                        "secondaryFinisherTypeFlagA",
                                        next.A
                                      ),
                                      ...setNumPatch(
                                        selectedWorker as any,
                                        "sfTypeFlagB",
                                        "secondaryFinisherTypeFlagB",
                                        next.B
                                      ),
                                      ...setNumPatch(
                                        selectedWorker as any,
                                        "sfTypeFlagC",
                                        "secondaryFinisherTypeFlagC",
                                        next.C
                                      ),
                                    } as any);
                                  }}
                                >
                                  {finisherTypeOptions.map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Generic fallback (only if old keys aren't present) */}
                      {!hasPrimary && !hasSecondary && (nameKey || (AKey && BKey && CKey)) ? (
                        <div className="ewr-grid ewr-gridAuto" style={{ marginTop: hasPrimary || hasSecondary ? 16 : 0 }}>
                          {nameKey ? (
                            <div className="ewr-field" style={{ gridColumn: "1 / -1" }}>
                              <div className="ewr-label">Finisher Name</div>
                              <input
                                className="ewr-input"
                                value={getStr(selectedWorker as any, nameKey)}
                                maxLength={40}
                                onChange={(e) =>
                                  updateSelected(
                                    setStrPatch(selectedWorker as any, nameKey, nameKey, e.target.value) as any
                                  )
                                }
                              />
                            </div>
                          ) : null}

                          {AKey && BKey && CKey ? (
                            <div className="ewr-field">
                              <div className="ewr-label">Finisher Type</div>
                              <select
                                className="ewr-input"
                                value={decodeFinisherTypeFromABC(
                                  getNum(selectedWorker as any, AKey),
                                  getNum(selectedWorker as any, BKey),
                                  getNum(selectedWorker as any, CKey)
                                )}
                                onChange={(e) => {
                                  const enc = encodeFinisherTypeToABC(e.target.value);
                                  updateSelected({ [AKey]: enc.A, [BKey]: enc.B, [CKey]: enc.C } as any);
                                }}
                              >
                                {finisherTypeOptions.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                              <div className="ewr-hint">Stored via A/B/C flags (EWR style).</div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })()}

              <div style={{ height: 18 }} />
            </>
          )}
        </div>
      </div>


      
      {csvModalOpen ? (
        <div className="ewr-modalOverlay" onMouseDown={closeCsvModal} role="dialog" aria-modal="true">
          <div className="ewr-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ewr-modalHeader">
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <div className="ewr-modalTitle">Import CSV</div>
                <div className="ewr-modalSub">
                  <span style={{ opacity: 0.85 }}>{csvSourcePath || ""}</span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button className="ewr-button" onClick={closeCsvModal} title="Close">
                  Close
                </button>
              </div>
            </div>

            <div className="ewr-modalBody" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="ewr-importSummary">
                <div><b>Rows:</b> {csvRowCount}</div>
                <div><b>Updates:</b> {csvPlannedUpdates.length}</div>
                <div><b>New:</b> {csvPlannedNewRows.length}</div>
                <div><b>Skipped duplicates:</b> {csvSkippedDuplicates.length}</div>
                <div><b>Invalid:</b> {csvInvalidRows.length}</div>
              </div>

              {csvImportInfo ? <div style={{ opacity: 0.9 }}>{csvImportInfo}</div> : null}

              {csvSkippedDuplicates.length ? (
                <div className="ewr-importBox">
                  <div className="ewr-importBoxTitle">Skipped duplicate names</div>
                  <div className="ewr-importScroll">
                    {csvSkippedDuplicates.map((n) => (
                      <div key={n} style={{ padding: "2px 0" }}>{n}</div>
                    ))}
                  </div>
                </div>
              ) : null}

              {csvInvalidRows.length ? (
                <div className="ewr-importBox">
                  <div className="ewr-importBoxTitle">Invalid rows</div>
                  <div className="ewr-importScroll">
                    {csvInvalidRows.map((e, idx) => (
                      <div key={`${e.row}-${e.field}-${idx}`} style={{ padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                        <div style={{ fontWeight: 850 }}>Row {e.row} — {e.field}</div>
                        <div style={{ opacity: 0.9 }}>{e.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
                <button className="ewr-button" onClick={closeCsvModal}>Cancel</button>
                <button
                  className="ewr-button ewr-buttonApply"
                  onClick={applyCsvImport}
                  disabled={csvPlannedUpdates.length === 0 && csvPlannedNewRows.length === 0}
                  title="Apply valid updates and additions"
                >
                  Apply Import
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

{importModalOpen ? (
        <div className="ewr-modalOverlay" onMouseDown={closeImportModal} role="dialog" aria-modal="true">
          <div className="ewr-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ewr-modalHeader">
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <div className="ewr-modalTitle">Import Worker</div>
                <div className="ewr-modalSub">
                  Source: <span className="ewr-mono">{importSourcePath ? importSourcePath.split(/[\\/]/).pop() : ""}</span>
                </div>
              </div>
              <button className="ewr-iconBtn" title="Close" onClick={closeImportModal} aria-label="Close import">
                ×
              </button>
            </div>

            <div className="ewr-modalBody">
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="ewr-input"
                  style={{ flex: 1, minWidth: 220 }}
                  placeholder="Filter workers by name…"
                  value={importSearch}
                  onChange={(e) => setImportSearch(e.target.value)}
                />

                <button
                  className="ewr-button ewr-buttonSmall"
                  type="button"
                  onClick={() => {
                    const all = new Set(importVisibleWorkers.map((w: any) => w.index));
                    setImportSelection(all);
                  }}
                >
                  Select All
                </button>

                <button
                  className="ewr-button ewr-buttonSmall"
                  type="button"
                  onClick={() => setImportSelection(new Set())}
                >
                  Clear
                </button>
              </div>

              <div className="ewr-modalList">
                {importVisibleWorkers.length === 0 ? (
                  <div className="ewr-muted">No workers found.</div>
                ) : (
                  importVisibleWorkers.map((w: any) => {
                    const name = String(w.fullName || w.shortName || "(no name)").trim();
                    const checked = importSelection.has(w.index);
                    return (
                      <label key={`imp-${w.index}-${w.id}`} className="ewr-importRow">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleImportSelection(w.index, e.target.checked)}
                        />
                        <span className="ewr-importName">{name}</span>
                      </label>
                    );
                  })
                )}
              </div>

              {importInfo ? <div className="ewr-importInfo">{importInfo}</div> : null}
            </div>

            <div className="ewr-modalFooter">
              <div className="ewr-muted" style={{ flex: 1 }}>
                Selected: <b>{importSelection.size}</b> / {importSourceWorkers.length}
              </div>

              <button className="ewr-button" type="button" onClick={closeImportModal}>
                Cancel
              </button>

              <button className="ewr-button ewr-buttonApply" type="button" onClick={commitImportSelected}>
                Import Selected
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Minimal SVG sizing + remove number spinners so manual entry is clean */}
      <style>{`
        .btnSvg { width: 22px; height: 22px; margin-right: 8px; display: inline-block; }
        .iconBtnSvg { width: 22px; height: 22px; display: inline-block; }

        /* Remove number spinners (Chrome/Safari/Edge) */
        input[type="number"]::-webkit-outer-spin-button,
        input[type="number"]::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        /* Remove number spinners (Firefox) */
        input[type="number"] {
          -moz-appearance: textfield;
          appearance: textfield;
        }
      `}</style>
    </div>
  );
}
