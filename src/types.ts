export type AssetKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'model'
  | 'document'
  | 'unknown'

export type AssetStatus = 'ready' | 'missing' | 'external' | 'removed'

export type ManifestKind = 'csv' | 'excel'

export interface ManifestSource {
  id: string
  name: string
  kind: ManifestKind
  file: File
  handle: FileSystemFileHandle
  size: number
  lastModified: number
}

export interface ManifestSnapshot {
  name: string
  kind: ManifestKind
  size: number
  lastModified: number
}

export interface IndexedFile {
  path: string
  basename: string
  handle: FileSystemFileHandle
}

export interface AssetRecord {
  id: string
  name: string
  kind: AssetKind
  typeLabel: string
  reference: string
  normalizedPath: string
  folder: string
  extension: string
  size?: number
  mime?: string
  status: AssetStatus
  sourceRow: number
  tags: string[]
  metadata: Record<string, string>
  isExternal: boolean
  fileHandle?: FileSystemFileHandle
  previewUrl?: string
  createdAt?: number
  updatedAt?: number
}

export type SerializableAssetRecord = Omit<
  AssetRecord,
  'fileHandle' | 'previewUrl'
>

export interface AssetIndexDoc {
  schemaVersion: 1
  generatedAt: string
  sourceRootName: string
  manifestSources: ManifestSnapshot[]
  assets: SerializableAssetRecord[]
}

export interface FavoriteEntry {
  id: string
  name: string
  kind: AssetKind
  reference: string
  normalizedPath: string
  addedAt: string
}

export interface FavoriteCollection {
  id: string
  name: string
  entries: FavoriteEntry[]
}

export interface HistoryEntry {
  id: string
  name: string
  kind: AssetKind
  reference: string
  normalizedPath: string
  openedAt: string
}

export interface RenameEntry {
  id: string
  from: string
  to: string
  renamedAt: string
}

export interface AppStateDoc {
  schemaVersion: 1
  updatedAt: string
  sourceRootName?: string
  activeManifestName?: string
  favorites: FavoriteCollection[]
  history: HistoryEntry[]
  renames: RenameEntry[]
  assetTags: Record<string, string[]>
  assetRatings: Record<string, number>
}

export interface ActivityItem {
  id: string
  level: 'info' | 'success' | 'warn' | 'fail'
  message: string
  time: string
}

export type StorageTarget = 'localStorage' | 'assetRoot' | 'customFolder'
