# AGENTS.md

## First: identify where you are

When an agent enters this folder or a folder that may be opened by Asset Browser, first decide which environment you are in before changing files.

You are in the **Asset Browser code repository** when the root has code-repo signals such as `package.json`, `vite.config.ts`, `src/App.tsx`, `src/lib/indexDocument.ts`, and this `AGENTS.md`.

You are in an **asset repository** when the root primarily contains assets and optional index files named exactly:

- `asset-browser-index.json`
- `asset-browser-index.csv`
- `asset-browser-index.xlsx`

Only these root-level names count as Asset Browser index files. Do not treat arbitrary CSV or Excel files as indexes.

If both kinds of signals exist, prefer code-repository behavior when `package.json` declares the Asset Browser app. Otherwise prefer asset-repository behavior and avoid editing app source assumptions.

## If This Is The Code Repository

Follow the existing React/Vite implementation and keep changes narrow.

- Use `rg` / `rg --files` for inspection.
- Use `apply_patch` for manual file edits.
- Do not revert unrelated user changes, generated output, or dirty worktree state unless explicitly asked.
- After code changes, run `npm run build` and `npm run lint`.
- For visible UI changes, verify the running app in the browser at the active localhost URL when available.

Index behavior is part of the app contract:

- The app recognizes only root-level `asset-browser-index.json`, `asset-browser-index.csv`, and `asset-browser-index.xlsx`.
- On folder open, valid current JSON is loaded without rewriting.
- If CSV/XLSX is newer than JSON, or JSON is missing/invalid, the app parses the newest CSV/XLSX source and writes a fresh JSON when write permission is available.
- `asset-browser-metadata.json` stores UI interaction state and must remain separate from the index so tags, ratings, collections, and history do not churn the index timestamp.

UI repair rules learned from the current design work:

- Preserve the quiet, dense Linear-like layout. Avoid decorative hero, marketing, card-inside-card, orb, or one-note gradient treatment.
- The left sidebar should visually merge with the app background. Its rows should be left aligned, with count/value content right aligned inside the row.
- Collapsed sidebar should be part of the background, not a floating card. The first collapsed control should expand the sidebar.
- The main filter/search row belongs inside the asset list card as its top toolbar.
- The asset title row is the alignment authority. Body columns must align to the same grid as the title row.
- Selection and `Name` stay on the left; `Actions` stays on the right. Middle asset columns may compress or scroll if width is tight.
- `Type` is an equal-width icon badge and is centered.
- `FileType` is plain text, not a pill.
- `Size` is right aligned and never wraps.
- `Rating`, `Tag`, and text columns are left aligned unless specifically requested otherwise.
- Tag pills may wrap to two lines without changing row height on hover or selection. Long tag text should truncate with ellipsis.
- Actions currently mean download and delete. Do not reintroduce duplicate favorite buttons into Actions.
- Log is a bottom inline control, not a floating window. In collapsed state it should be compact, right aligned, and visually aligned with `Generate Index`.

## If This Is An Asset Repository

Generate and maintain index files in the asset root. The canonical base name is always `asset-browser-index`.

Target tabular columns:

- `name`: file name or display name
- `path`: relative path from the asset root, using `/`
- `type`: Asset Browser kind: `image`, `audio`, `video`, `model`, `document`, or `unknown`
- `filetype`: actual extension, uppercase when written to CSV/XLSX
- `size`: file size in MB
- `collection`: direct parent folder name; use `root` for files directly under the asset root

The app parser currently consumes `name`, `type`, `path`, and optional `tags` from CSV/XLSX. Keep `filetype`, `size`, and `collection` as useful metadata columns; they will be preserved in JSON asset metadata.

### Case 1: CSV or Excel already exists

If the root already has `asset-browser-index.csv` or `asset-browser-index.xlsx`, use it as the source manifest.

1. If both CSV and XLSX exist, choose the newest by modification time.
2. Validate the source has at least a usable path/reference column, preferably `name,type,path,filetype,size,collection`.
3. If `asset-browser-index.json` is missing, invalid, older than the chosen CSV/XLSX, or its manifest snapshot no longer matches the source file name/size/mtime, regenerate JSON from the chosen source.
4. If JSON is valid and current, do not rewrite it.
5. After generation, validate JSON parses and follows the Asset Browser shape: `schemaVersion: 1`, string `generatedAt`, string `sourceRootName`, array `manifestSources`, array `assets`.

### Case 2: no valid index file exists

If the root has no matching `asset-browser-index.json`, `.csv`, or `.xlsx`, scan the directory tree and create new index files.

Recommended script design:

1. Walk the root recursively.
2. Skip hidden paths, `node_modules`, `.git`, existing `asset-browser-index.*`, and `asset-browser-metadata.json`.
3. For each file, collect `name`, relative `path`, inferred `type`, uppercase `filetype`, `size` in MB, and direct-parent `collection`.
4. Write `asset-browser-index.csv`.
5. Write `asset-browser-index.xlsx` with the same columns when an Excel writer is available.
6. Write `asset-browser-index.json` using the same records, with stable ids derived from `name:path:index`.

Use this portable Node script shape when no local tool already exists:

```js
// scripts/generate-asset-browser-index.mjs
import { createHash } from 'node:crypto'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
const base = 'asset-browser-index'
const skipDirs = new Set(['.git', 'node_modules'])
const typeByExt = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  glb: 'model', gltf: 'model', obj: 'model', stl: 'model', fbx: 'model',
  pdf: 'document', txt: 'document', md: 'document', json: 'document',
}

function idFor(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function walk(dir, prefix = '') {
  const rows = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      rows.push(...await walk(path.join(dir, entry.name), path.posix.join(prefix, entry.name)))
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name === `${base}.json` || entry.name === `${base}.csv` || entry.name === `${base}.xlsx`) continue
    if (entry.name === 'asset-browser-metadata.json') continue

    const absolute = path.join(dir, entry.name)
    const info = await stat(absolute)
    const rel = path.posix.join(prefix, entry.name)
    const ext = path.extname(entry.name).slice(1).toLowerCase()
    rows.push({
      name: entry.name,
      path: rel,
      type: typeByExt[ext] ?? 'unknown',
      filetype: ext.toUpperCase(),
      size: Number((info.size / 1024 / 1024).toFixed(3)),
      collection: prefix.split('/').filter(Boolean).pop() ?? 'root',
      mtimeMs: info.mtimeMs,
    })
  }
  return rows
}

const rows = (await walk(root)).sort((a, b) => a.path.localeCompare(b.path))
const columns = ['name', 'path', 'type', 'filetype', 'size', 'collection']
const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(','))].join('\n')
const csvContent = `${csv}\n`
await writeFile(path.join(root, `${base}.csv`), csvContent)

try {
  const xlsxModule = await import('xlsx')
  const XLSX = xlsxModule.default ?? xlsxModule
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.json_to_sheet(rows.map((row) => Object.fromEntries(columns.map((key) => [key, row[key]]))))
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Assets')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  await writeFile(path.join(root, `${base}.xlsx`), buffer)
} catch {
  console.warn('Skipped XLSX because the xlsx package is not available. Install/use SheetJS xlsx or openpyxl, then write the same columns.')
}

const now = new Date().toISOString()
const assets = rows.map((row, index) => ({
  id: idFor(`${row.name}:${row.path}:${index}`),
  name: row.name,
  kind: row.type,
  typeLabel: row.type,
  reference: row.path,
  normalizedPath: row.path,
  folder: row.path.split('/').slice(0, -1).join('/') || 'root',
  extension: row.filetype.toLowerCase(),
  size: Math.round(row.size * 1024 * 1024),
  status: 'ready',
  sourceRow: index + 2,
  tags: [],
  metadata: {
    filetype: row.filetype,
    sizeMB: String(row.size),
    collection: row.collection,
  },
  isExternal: false,
  updatedAt: row.mtimeMs,
}))

await writeFile(path.join(root, `${base}.json`), JSON.stringify({
  schemaVersion: 1,
  generatedAt: now,
  sourceRootName: path.basename(root),
  manifestSources: [{
    name: `${base}.csv`,
    kind: 'csv',
    size: Buffer.byteLength(csvContent),
    lastModified: Date.now(),
  }],
  assets,
}, null, 2))

console.log(`Wrote ${base}.csv and ${base}.json with ${rows.length} assets.`)
```

### Case 3: JSON exists but CSV/XLSX does not

If `asset-browser-index.json` exists and no CSV/XLSX exists:

1. Validate JSON first.
2. If JSON is valid, do not rewrite it just to change timestamps.
3. If a tabular file is requested, export `asset-browser-index.csv` and `asset-browser-index.xlsx` from the JSON `assets` array using the target columns above.
4. If JSON is invalid and there is no CSV/XLSX source, fall back to Case 2 and rebuild from the directory tree.

## Validation Checklist For Asset Repositories

After any index work:

- Confirm only root-level `asset-browser-index.*` files were created or updated.
- Confirm all paths are relative to the asset root and use `/`.
- Confirm JSON parses with `JSON.parse`.
- Confirm each JSON asset has at least `id`, `name`, `kind`, `typeLabel`, `reference`, `normalizedPath`, `folder`, `extension`, `status`, `sourceRow`, `tags`, `metadata`, and `isExternal`.
- Confirm `size` in CSV/XLSX is MB, while JSON `size` is bytes when available.
- Do not modify actual asset files unless explicitly asked.
