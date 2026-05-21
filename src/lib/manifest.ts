import Papa from 'papaparse'
import { readSheet, type Row } from 'read-excel-file/browser'
import type { AssetKind, AssetRecord, IndexedFile, ManifestSource } from '../types'
import {
  getExtension,
  normalizeAssetPath,
  resolveIndexedFile,
  stableId,
} from './fileSystem'

type FileIndex = {
  byPath: Map<string, IndexedFile>
  byBasename: Map<string, IndexedFile[]>
}

type ParseManifestOptions = {
  resolveFiles?: boolean
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

const TYPE_WORDS: Array<[RegExp, AssetKind]> = [
  [/image|img|picture|texture|sprite|贴图|图片|图像/i, 'image'],
  [/audio|sound|music|voice|音频|声音|音乐/i, 'audio'],
  [/video|movie|clip|视频|影片|动画视频/i, 'video'],
  [/model|mesh|gltf|glb|fbx|obj|vox|voxel|magicavoxel|3d|三维|模型|体素|动画/i, 'model'],
  [/doc|text|pdf|document|文档/i, 'document'],
]

const FIELD_ALIASES = {
  name: [
    'name',
    'assetname',
    'asset',
    'title',
    'displayname',
    'filename',
    '名称',
    '资产名称',
    '名字',
    '文件名',
  ],
  type: [
    'type',
    'kind',
    'category',
    'assettype',
    'mime',
    '类型',
    '资产类型',
    '类别',
    '分类',
  ],
  reference: [
    'path',
    'url',
    'uri',
    'address',
    'reference',
    'ref',
    'filepath',
    'file',
    'source',
    'location',
    '路径',
    '地址',
    '引用',
    '文件',
    '资源地址',
    '文件路径',
  ],
  tags: ['tags', 'tag', 'labels', 'keywords', '标签', '关键词'],
  size: ['size', 'sizemb', 'sizeinmb', '大小', '文件大小'],
  createdAt: ['createdat', 'created', 'creationdate', 'createddate', 'ctime', '创建日期', '创建时间'],
  updatedAt: ['updatedat', 'modifiedat', 'lastmodified', 'mtime', '修改日期', '修改时间', '最后修改日期', '最后修改时间'],
}

export async function parseManifest(
  manifest: ManifestSource,
  fileIndex: FileIndex,
  options: ParseManifestOptions = {},
) {
  const { resolveFiles = true } = options
  const rows = manifest.kind === 'csv'
    ? await parseCsv(manifest.file)
    : await parseWorkbook(manifest.file)

  const normalizedRows: AssetRecord[] = []
  rows.forEach((row, rowIndex) => {
    const asset = normalizeRow(row, rowIndex, fileIndex, { resolveFiles })
    if (asset) normalizedRows.push(asset)
  })
  return normalizedRows
}

function parseCsv(file: File) {
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => resolve(result.data),
      error: (error) => reject(error),
    })
  })
}

async function parseWorkbook(file: File) {
  const rows = await readSheet(file)
  const [headers = [], ...body] = rows as Row[]
  return body.map((row) => {
    return Object.fromEntries(
      headers.map((header, index) => {
        const key =
          header === null || header === undefined
            ? `Column ${index + 1}`
            : String(header)
        return [key, row[index] ?? '']
      }),
    )
  })
}

function normalizeRow(
  row: Record<string, unknown>,
  rowIndex: number,
  fileIndex: FileIndex,
  options: Required<ParseManifestOptions>,
): AssetRecord | null {
  const keys = Object.keys(row)
  if (keys.length === 0) return null

  const fields = {
    name: pickField(row, FIELD_ALIASES.name),
    type: pickField(row, FIELD_ALIASES.type),
    reference: pickField(row, FIELD_ALIASES.reference),
    tags: pickField(row, FIELD_ALIASES.tags),
    size: pickField(row, FIELD_ALIASES.size),
    createdAt: pickField(row, FIELD_ALIASES.createdAt),
    updatedAt: pickField(row, FIELD_ALIASES.updatedAt),
  }

  const reference = fields.reference || findReferenceFallback(row)
  if (!reference) return null

  const normalizedPath = normalizeAssetPath(reference)
  const indexedFile = !options.resolveFiles || isExternalReference(reference)
    ? undefined
    : resolveIndexedFile(reference, fileIndex)
  const extension = getExtension(indexedFile?.path || normalizedPath)
  const typeLabel = fields.type || extension || 'unknown'
  const kind = inferKind(typeLabel, extension)
  const displayName =
    fields.name ||
    indexedFile?.basename ||
    normalizedPath.split('/').pop() ||
    `Asset ${rowIndex + 1}`

  const metadata = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, stringifyCell(value)]),
  )

  const status: AssetRecord['status'] = isExternalReference(reference)
    ? 'external'
    : indexedFile
      ? 'ready'
      : options.resolveFiles
        ? 'missing'
        : 'ready'

  return {
    id: stableId(`${displayName}:${reference}:${rowIndex}`),
    name: displayName,
    kind,
    typeLabel,
    reference,
    normalizedPath: indexedFile?.path || normalizedPath,
    folder: folderName(indexedFile?.path || normalizedPath),
    extension,
    size: parseSizeBytes(fields.size),
    sourceRow: rowIndex + 2,
    tags: splitTags(fields.tags),
    metadata,
    status,
    isExternal: isExternalReference(reference),
    fileHandle: indexedFile?.handle,
    createdAt: parseDateTime(fields.createdAt),
    updatedAt: parseDateTime(fields.updatedAt),
  }
}

function pickField(row: Record<string, unknown>, aliases: string[]) {
  const lookup = new Map(
    Object.entries(row).map(([key, value]) => [normalizeKey(key), value]),
  )
  for (const alias of aliases) {
    const value = lookup.get(normalizeKey(alias))
    if (value !== undefined && stringifyCell(value)) return stringifyCell(value)
  }
  return ''
}

function findReferenceFallback(row: Record<string, unknown>) {
  for (const value of Object.values(row)) {
    const text = stringifyCell(value)
    if (!text) continue
    if (isExternalReference(text) || getExtension(text)) return text
  }
  return ''
}

function inferKind(typeLabel: string, extension: string): AssetKind {
  const byExtension = TYPE_BY_EXTENSION[extension]
  if (byExtension) return byExtension

  for (const [pattern, kind] of TYPE_WORDS) {
    if (pattern.test(typeLabel)) return kind
  }

  return 'unknown'
}

function splitTags(value: string) {
  if (!value) return []
  return value
    .split(/[;,，、|]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function folderName(path: string) {
  const parts = normalizeAssetPath(path).split('/').filter(Boolean)
  parts.pop()
  return parts.join('/') || 'root'
}

function stringifyCell(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeKey(value: string) {
  const ignored = new Set(' _-./:：()（）[]【】')
  return Array.from(value.toLocaleLowerCase())
    .filter((char) => !ignored.has(char))
    .join('')
}

function parseSizeBytes(value: string) {
  if (!value) return undefined
  const normalized = value.replace(/,/g, '').trim().toLocaleLowerCase()
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(normalized)
  if (!match) return undefined

  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined

  const unit = match[2] ?? 'mb'
  const multiplier =
    unit === 'gb'
      ? 1024 * 1024 * 1024
      : unit === 'kb'
        ? 1024
        : unit === 'b'
          ? 1
          : 1024 * 1024

  return Math.round(amount * multiplier)
}

function parseDateTime(value: string) {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export function isExternalReference(value: string) {
  return /^https?:\/\//i.test(value.trim())
}

export function getKindLabel(kind: AssetKind) {
  const labels: Record<AssetKind, string> = {
    image: 'Image',
    audio: 'Audio',
    video: 'Video',
    model: '3D',
    document: 'Doc',
    unknown: 'Other',
  }
  return labels[kind]
}
