# EWR 4.2 WRESTLER.DAT Editor (ewr_editor)

A desktop editor for **Extreme Warfare Revenge (EWR) 4.2** that lets you open, edit, validate, and save `wrestler.dat` safely and fast.

Built with **Tauri v2 + Vite/React + TypeScript**, using **schema-driven fixed-offset parsing/writing** to reduce the risk of corrupting your database.

---

## Downloads (Windows + macOS)

**Latest release (recommended):**
- https://github.com/totalextreme-apps/ewr-editor/releases/latest

**v0.2.5 release page:**
- https://github.com/totalextreme-apps/ewr-editor/releases/tag/v0.2.5

### Which file do I download?
Go to the release page and download the correct asset:

- **Windows**
  - Look for: `*.exe` (installer) and/or `*.msi`
- **macOS (Apple Silicon / M1/M2/M3)**
  - Look for: `*aarch64*` or `*arm64*`
- **macOS (Intel)**
  - Look for: `*x86_64*`

> Note: Builds are **unsigned**, so OS warnings are expected (see below).

---

## Features

### Core editing
- Open / edit / save **EWR 4.2 `wrestler.dat`**
- Automatic timestamped **backup (.bak)** created on save
- Validation checks to catch invalid data before writing

### Profile editor
Edit worker profile fields including:
- `fullName`, `shortName`, `photoName`
- `gender`, `nationality`, `birthMonth`, `age`, `weight`, `speaks`
- `wage`
- skills (0–100)
- attributes/flags (Yes/No style inputs)
- finishers (names + primary/secondary types)

### Skills Grid (spreadsheet-style)
- Bulk edit skills in a fast grid
- Sorting and quick navigation
- Works well for building a database at speed

### Advanced filters + search
Filter workers by combinations like:
- nationality, gender
- skill ranges (ex: Brawling 80–100)
- wage range
- age range
- weight, birth month, speaks
- flags/attributes (ex: superstarLook, menacing, fonzFactor, highSpots, shootingAbility, trainer, announcer, booker, diva)
- finisher types

### Import Worker(s) from another `wrestler.dat`
- Select another EWR `wrestler.dat`
- Choose one or multiple workers to import
- Dedupe by **fullName** (skips duplicates and reports them)
- New workers get new IDs/record numbers automatically

### External Editing (CSV)
- Export a user-editable **CSV**
- Re-import CSV with:
  - preview + summary (updates / new / skipped / invalid)
  - detailed validation errors by row/field
  - Apply/Cancel to prevent accidental changes

### Compare Skills tool
- Choose another worker to display their skills below yours (read-only) for easy benchmarking

---

## CSV Rules (important)
The CSV import is strict by design to prevent corrupt saves:
- Skills must be **0–100**
- Flags/attributes are **Yes/No**
- Names must respect EWR limits (and are validated)
- Invalid rows are rejected with clear errors instead of writing bad data

---

## Unsigned build warnings (expected)

### Windows
SmartScreen may appear:
- Click **More info** → **Run anyway**

### macOS
Gatekeeper may block first launch:
- Right-click the app → **Open**
or
- System Settings → **Privacy & Security** → allow the app

---

## Build from source (developers)

### Requirements
- Node.js 20+
- Rust toolchain
- Tauri prerequisites (per platform)

### Run dev
```bash
npm install
npm run dev
