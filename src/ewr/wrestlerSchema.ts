export type FieldType =
  | "u8"
  | "u16le"
  | "i16le"
  | "ascii"
  | "bool16"; // raw 0/65535 convenience

export type FieldDef = {
  name: string;
  offset: number;
  type: FieldType;
  length?: number; // required for ascii
};

export type WrestlerDatSchema = {
  recordSize: number;
  marker: number; // byte value at offset 0
  fields: FieldDef[];
  mappings?: Record<string, Record<string, string>>;
};

// Your current schema (partial). When you expand docs JSON later,
// copy it here or load it dynamically (later improvement).
export const wrestlerDatSchema: WrestlerDatSchema = {
  recordSize: 307,
  marker: 52,
  fields: [{ name: "id", offset: 1, type: "u16le" }],
  mappings: {
    gender: { "0": "Female", "65535": "Male" },
    weight: { "72": "Heavyweight", "76": "Lightweight" },
    nationality: {
      "0": "Other",
      "1": "American",
      "2": "Australian",
      "3": "British",
      "4": "Canadian",
      "5": "European",
      "6": "Japanese",
      "7": "Mexican",
    },
    birthMonth: {
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
    },
  },
};
