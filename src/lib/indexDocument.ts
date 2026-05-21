import type {
  AssetIndexDoc,
  AssetRecord,
  IndexedFile,
  ManifestSnapshot,
  ManifestSource,
  SerializableAssetRecord,
} from '../types'
import {
  INDEX_BASENAME,
  readJsonFileWithMeta,
  resolveIndexedFile,
  stableId,
  writeJsonFile,
} from './fileSystem'
import { parseManifest } from './manifest'

export const INDEX_FILENAME = `${INDEX_BASENAME}.json`

type FileIndex = {
  byPath: Map<string, IndexedFile>
  byBasename: Map<string, IndexedFile[]>
}

export type IndexSyncResult = {
  doc: AssetIndexDoc
  status: 'created' | 'updated' | 'loaded' | 'empty'
  reason: string
  indexLastModified?: number
  writeError?: string
  writeSkipped?: boolean
}

type SyncIndexOptions = {
  persist?: boolean
  resolveFiles?: boolean
}

export async function syncIndexDocument(
  root: FileSystemDirectoryHandle,
  rootName: string,
  manifests: ManifestSource[],
  fileIndex: FileIndex,
  options: SyncIndexOptions = {},
): Promise<IndexSyncResult> {
  const { persist = true, resolveFiles = true } = options
  const latestManifest = getLatestManifest(manifests)
  const currentSources = createManifestSnapshots(
    latestManifest ? [latestManifest] : [],
  )

  let existing: { data: AssetIndexDoc; file: File } | undefined
  let invalidReason = ''
  try {
    const candidate = await readJsonFileWithMeta<unknown>(root, INDEX_FILENAME)
    if (isAssetIndexDoc(candidate.data)) {
      existing = { ...candidate, data: candidate.data }
    } else {
      invalidReason = 'index json is invalid'
    }
  } catch (error) {
    invalidReason =
      error instanceof SyntaxError ? 'index json parse failed' : 'index missing'
    existing = undefined
  }

  const staleReason = getStaleReason(existing?.data, existing?.file, currentSources)
  if (!staleReason && existing) {
    return {
      doc: existing.data,
      status: 'loaded',
      reason: 'index is current',
      indexLastModified: existing.file.lastModified,
    }
  }

  if (!latestManifest && !existing && invalidReason === 'index missing') {
    return {
      doc: createIndexDoc(rootName, currentSources, []),
      status: 'empty',
      reason: invalidReason || 'no manifests or index',
    }
  }

  if (!latestManifest) {
    throw new Error(`${INDEX_FILENAME} 不合法，并且没有找到 ${INDEX_BASENAME}.csv 或 ${INDEX_BASENAME}.xlsx。`)
  }

  const assets = await parseAllManifests([latestManifest], fileIndex, {
    resolveFiles,
  })
  const nextDoc = createIndexDoc(rootName, currentSources, assets)
  if (!persist) {
    return {
      doc: nextDoc,
      status: existing ? 'updated' : 'created',
      reason: staleReason || invalidReason || 'index created',
      writeSkipped: true,
    }
  }

  try {
    await writeJsonFile(root, INDEX_FILENAME, nextDoc)
  } catch (error) {
    return {
      doc: nextDoc,
      status: existing ? 'updated' : 'created',
      reason: staleReason || invalidReason || 'index created',
      writeError: error instanceof Error ? error.message : '未知错误',
    }
  }

  return {
    doc: nextDoc,
    status: existing ? 'updated' : 'created',
    reason: staleReason || invalidReason || 'index created',
  }
}

export function hydrateIndexAssets(
  doc: AssetIndexDoc,
  fileIndex: FileIndex,
  options: { resolveFiles?: boolean } = {},
) {
  const { resolveFiles = true } = options
  return doc.assets.map((asset) => {
    if (asset.isExternal) return { ...asset, status: 'external' } satisfies AssetRecord
    if (!resolveFiles) return { ...asset } satisfies AssetRecord
    const indexed = resolveIndexedFile(asset.normalizedPath || asset.reference, fileIndex)
    return {
      ...asset,
      normalizedPath: indexed?.path ?? asset.normalizedPath,
      status: indexed ? 'ready' : 'missing',
      fileHandle: indexed?.handle,
    } satisfies AssetRecord
  })
}

export function createManifestSnapshots(manifests: ManifestSource[]) {
  return manifests
    .map((manifest) => ({
      name: manifest.name,
      kind: manifest.kind,
      size: manifest.size,
      lastModified: manifest.lastModified,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function parseAllManifests(
  manifests: ManifestSource[],
  fileIndex: FileIndex,
  options: { resolveFiles?: boolean } = {},
) {
  const parsed = await Promise.all(
    manifests.map(async (manifest) => {
      const assets = await parseManifest(manifest, fileIndex, options)
      return assets.map((asset) => ({
        ...asset,
        id: stableId(`${manifest.name}:${asset.id}`),
        metadata: {
          ...asset.metadata,
          sourceManifest: manifest.name,
        },
      }))
    }),
  )
  return parsed.flat()
}

function createIndexDoc(
  rootName: string,
  sources: ManifestSnapshot[],
  assets: AssetRecord[],
): AssetIndexDoc {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRootName: rootName,
    manifestSources: sources,
    assets: assets.map(serializeAsset),
  }
}

function serializeAsset(asset: AssetRecord): SerializableAssetRecord {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    typeLabel: asset.typeLabel,
    reference: asset.reference,
    normalizedPath: asset.normalizedPath,
    folder: asset.folder,
    extension: asset.extension,
    size: asset.size,
    mime: asset.mime,
    status: asset.status,
    sourceRow: asset.sourceRow,
    tags: asset.tags,
    metadata: asset.metadata,
    isExternal: asset.isExternal,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  }
}

function getStaleReason(
  doc: AssetIndexDoc | undefined,
  indexFile: File | undefined,
  currentSources: ManifestSnapshot[],
) {
  if (!doc || !indexFile) return 'index missing'
  if (currentSources.length === 0) return ''
  const newerSource = currentSources.find(
    (source) => source.lastModified > indexFile.lastModified,
  )
  if (newerSource) return `${newerSource.name} is newer than index`
  if (!sameManifestSnapshot(doc.manifestSources, currentSources)) {
    return 'manifest source changed'
  }
  return ''
}

function sameManifestSnapshot(
  left: ManifestSnapshot[] = [],
  right: ManifestSnapshot[] = [],
) {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return (
      item.name === other.name &&
      item.kind === other.kind &&
      item.size === other.size &&
      item.lastModified === other.lastModified
    )
  })
}

function getLatestManifest(manifests: ManifestSource[]) {
  return manifests
    .slice()
    .sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name))[0]
}

function isAssetIndexDoc(value: unknown): value is AssetIndexDoc {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<AssetIndexDoc>
  if (doc.schemaVersion !== 1) return false
  if (typeof doc.generatedAt !== 'string') return false
  if (typeof doc.sourceRootName !== 'string') return false
  if (!Array.isArray(doc.manifestSources)) return false
  if (!Array.isArray(doc.assets)) return false
  return doc.assets.every(isSerializableAssetRecord)
}

function isSerializableAssetRecord(value: unknown): value is SerializableAssetRecord {
  if (!value || typeof value !== 'object') return false
  const asset = value as Partial<SerializableAssetRecord>
  return (
    typeof asset.id === 'string' &&
    typeof asset.name === 'string' &&
    typeof asset.kind === 'string' &&
    typeof asset.typeLabel === 'string' &&
    typeof asset.reference === 'string' &&
    typeof asset.normalizedPath === 'string' &&
    typeof asset.folder === 'string' &&
    typeof asset.extension === 'string' &&
    typeof asset.status === 'string' &&
    typeof asset.sourceRow === 'number' &&
    Array.isArray(asset.tags) &&
    Boolean(asset.metadata) &&
    typeof asset.metadata === 'object' &&
    typeof asset.isExternal === 'boolean'
  )
}
