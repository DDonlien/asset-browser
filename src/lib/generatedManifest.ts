import Papa from 'papaparse'
import type { AssetKind, IndexedFile } from '../types'
import { getExtension, INDEX_BASENAME, writeTextFile } from './fileSystem'

type FileIndex = {
  byPath: Map<string, IndexedFile>
}

type GeneratedManifestProgress = {
  processed: number
  total: number
  currentPath: string
}

type GeneratedManifestOptions = {
  onProgress?: (progress: GeneratedManifestProgress) => void
}

type GeneratedManifestRow = {
  name: string
  path: string
  type: AssetKind
  filetype: string
  size: number
  collection: string
  createdAt: string
  updatedAt: string
}

const TYPE_BY_EXTENSION: Record<string, AssetKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  glb: 'model',
  gltf: 'model',
  obj: 'model',
  stl: 'model',
  fbx: 'model',
  vox: 'model',
  pdf: 'document',
  txt: 'document',
  md: 'document',
  json: 'document',
}

const GENERATED_MANIFEST_COLUMNS: Array<keyof GeneratedManifestRow> = [
  'name',
  'path',
  'type',
  'filetype',
  'size',
  'collection',
  'createdAt',
  'updatedAt',
]

export const GENERATED_MANIFEST_FILENAME = `${INDEX_BASENAME}.csv`

export async function writeGeneratedCsvManifest(
  root: FileSystemDirectoryHandle,
  fileIndex: FileIndex,
  options: GeneratedManifestOptions = {},
) {
  const rows = await createGeneratedManifestRows(fileIndex, options)
  const csv = Papa.unparse(rows, { columns: GENERATED_MANIFEST_COLUMNS })
  await writeTextFile(root, GENERATED_MANIFEST_FILENAME, `${csv}\n`)
  return rows.length
}

async function createGeneratedManifestRows(
  fileIndex: FileIndex,
  options: GeneratedManifestOptions,
) {
  const files = Array.from(fileIndex.byPath.values())
    .filter((file) => !isGeneratedManifestIgnored(file.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  const rows: GeneratedManifestRow[] = []

  for (const file of files) {
    const source = await file.handle.getFile()
    const extension = getExtension(file.path)
    rows.push({
      name: file.basename,
      path: file.path,
      type: TYPE_BY_EXTENSION[extension] ?? 'unknown',
      filetype: extension.toUpperCase(),
      size: Number((source.size / 1024 / 1024).toFixed(3)),
      collection: directParentName(file.path),
      createdAt: formatFileTimestamp(source.lastModified),
      updatedAt: formatFileTimestamp(source.lastModified),
    })

    if (rows.length === 1 || rows.length % 100 === 0 || rows.length === files.length) {
      options.onProgress?.({
        processed: rows.length,
        total: files.length,
        currentPath: file.path,
      })
    }
  }

  return rows
}

function formatFileTimestamp(value: number) {
  return new Date(value).toISOString()
}

function directParentName(path: string) {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.pop() ?? 'root'
}

function isGeneratedManifestIgnored(path: string) {
  const filename = path.split('/').pop() ?? ''
  return (
    filename === `${INDEX_BASENAME}.json` ||
    filename === `${INDEX_BASENAME}.csv` ||
    filename === `${INDEX_BASENAME}.xlsx` ||
    filename === 'asset-browser-metadata.json'
  )
}
