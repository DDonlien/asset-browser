import type { IndexedFile, ManifestSource } from '../types'

export const INDEX_BASENAME = 'asset-browser-index'
const MANIFEST_EXTENSIONS = new Set(['csv', 'xlsx'])

type FileIndexProgress = {
  files: number
  directories: number
  currentPath: string
}

type FileIndexOptions = {
  onProgress?: (progress: FileIndexProgress) => void
}

export const supportsFileSystemAccess = () =>
  typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'

export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'read',
) {
  if (!handle.queryPermission || !handle.requestPermission) return true
  const current = await handle.queryPermission({ mode })
  if (current === 'granted') return true
  const next = await handle.requestPermission({ mode })
  return next === 'granted'
}

export async function pickDirectory(mode: 'read' | 'readwrite' = 'readwrite') {
  if (!window.showDirectoryPicker) {
    throw new Error('当前浏览器不支持直接选择文件夹。请使用 Chrome 或 Edge。')
  }
  const handle = await window.showDirectoryPicker({ mode })
  if (mode === 'read') return handle
  const ok = await ensurePermission(handle, mode)
  if (!ok) throw new Error('没有获得该文件夹的访问权限。')
  return handle
}

export async function findManifestFiles(root: FileSystemDirectoryHandle) {
  const manifests: ManifestSource[] = []
  for await (const [, handle] of root.entries()) {
    if (handle.kind !== 'file') continue
    const extension = getExtension(handle.name)
    if (!MANIFEST_EXTENSIONS.has(extension)) continue
    const basename = handle.name.slice(0, -(extension.length + 1))
    if (basename !== INDEX_BASENAME) continue
    const fileHandle = handle as FileSystemFileHandle
    const file = await fileHandle.getFile()
    manifests.push({
      id: stableId(`manifest:${handle.name}:${file.lastModified}`),
      name: handle.name,
      kind: extension === 'csv' ? 'csv' : 'excel',
      file,
      handle: fileHandle,
      size: file.size,
      lastModified: file.lastModified,
    })
  }
  return manifests.sort((a, b) => a.name.localeCompare(b.name))
}

export async function inspectDirectoryWorkload(root: FileSystemDirectoryHandle) {
  let files = 0
  let directories = 1
  let maxDepth = 0
  const topLevelDirectories = new Set<string>()

  async function walk(directory: FileSystemDirectoryHandle, parts: string[]) {
    maxDepth = Math.max(maxDepth, parts.length)
    for await (const [name, handle] of directory.entries()) {
      if (name.startsWith('.')) continue
      if (handle.kind === 'directory') {
        directories += 1
        if (parts.length === 0) topLevelDirectories.add(name)
        await walk(handle as FileSystemDirectoryHandle, [...parts, name])
        continue
      }
      files += 1
    }
  }

  await walk(root, [])
  return {
    files,
    directories,
    maxDepth,
    topLevelDirectories: Array.from(topLevelDirectories).sort(),
  }
}

export async function buildFileIndex(
  root: FileSystemDirectoryHandle,
  options: FileIndexOptions = {},
) {
  const byPath = new Map<string, IndexedFile>()
  const byBasename = new Map<string, IndexedFile[]>()
  let directories = 1

  async function walk(directory: FileSystemDirectoryHandle, parts: string[]) {
    for await (const [name, handle] of directory.entries()) {
      if (name.startsWith('.')) continue
      if (handle.kind === 'directory') {
        directories += 1
        options.onProgress?.({
          files: byPath.size,
          directories,
          currentPath: [...parts, name].join('/') || name,
        })
        await walk(handle as FileSystemDirectoryHandle, [...parts, name])
        continue
      }
      const path = [...parts, name].join('/')
      const indexed: IndexedFile = {
        path,
        basename: name,
        handle: handle as FileSystemFileHandle,
      }
      byPath.set(normalizeLookupPath(path), indexed)
      const basenameKey = normalizeLookupPath(name)
      const list = byBasename.get(basenameKey) ?? []
      list.push(indexed)
      byBasename.set(basenameKey, list)
      if (byPath.size === 1 || byPath.size % 100 === 0) {
        options.onProgress?.({
          files: byPath.size,
          directories,
          currentPath: path,
        })
      }
    }
  }

  await walk(root, [])
  return { byPath, byBasename }
}

export function resolveIndexedFile(
  reference: string,
  index: Awaited<ReturnType<typeof buildFileIndex>>,
) {
  const normalized = normalizeAssetPath(reference)
  if (!normalized) return undefined

  const direct = index.byPath.get(normalizeLookupPath(normalized))
  if (direct) return direct

  const basename = normalized.split('/').pop()
  if (!basename) return undefined
  const byName = index.byBasename.get(normalizeLookupPath(basename))
  return byName?.length === 1 ? byName[0] : undefined
}

export async function getDirectoryForPath(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create = false,
) {
  let current = root
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create })
  }
  return current
}

export async function getFileHandleAtPath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
) {
  const parts = normalizeAssetPath(relativePath).split('/').filter(Boolean)
  const filename = parts.pop()
  if (!filename) throw new Error('缺少文件名。')
  const directory = await getDirectoryForPath(root, parts)
  return directory.getFileHandle(filename)
}

export async function writeJsonFile(
  directory: FileSystemDirectoryHandle,
  filename: string,
  data: unknown,
) {
  await ensurePermission(directory, 'readwrite')
  const fileHandle = await directory.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(data, null, 2))
  await writable.close()
}

export async function writeTextFile(
  directory: FileSystemDirectoryHandle,
  filename: string,
  text: string,
) {
  await ensurePermission(directory, 'readwrite')
  const fileHandle = await directory.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(text)
  await writable.close()
}

export async function readJsonFile<T>(
  directory: FileSystemDirectoryHandle,
  filename: string,
) {
  const fileHandle = await directory.getFileHandle(filename)
  const file = await fileHandle.getFile()
  return JSON.parse(await file.text()) as T
}

export async function readJsonFileWithMeta<T>(
  directory: FileSystemDirectoryHandle,
  filename: string,
) {
  const fileHandle = await directory.getFileHandle(filename)
  const file = await fileHandle.getFile()
  return {
    data: JSON.parse(await file.text()) as T,
    file,
    handle: fileHandle,
  }
}

export async function deleteFileAtPath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
) {
  const parts = normalizeAssetPath(relativePath).split('/').filter(Boolean)
  const filename = parts.pop()
  if (!filename) throw new Error('缺少文件名，无法删除。')
  const parent = await getDirectoryForPath(root, parts)
  await ensurePermission(parent, 'readwrite')
  await parent.removeEntry(filename)
}

export async function renameFileAtPath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  newName: string,
) {
  const parts = normalizeAssetPath(relativePath).split('/').filter(Boolean)
  const oldName = parts.pop()
  if (!oldName) throw new Error('缺少文件名，无法重命名。')
  const parent = await getDirectoryForPath(root, parts)
  await ensurePermission(parent, 'readwrite')
  const oldHandle = await parent.getFileHandle(oldName)
  const oldFile = await oldHandle.getFile()
  const nextHandle = await parent.getFileHandle(newName, { create: true })
  const writable = await nextHandle.createWritable()
  await writable.write(oldFile)
  await writable.close()
  await parent.removeEntry(oldName)
  return [...parts, newName].join('/')
}

export async function copyFileToDirectory(
  targetRoot: FileSystemDirectoryHandle,
  relativePath: string,
  file: File | Blob,
  preserveFolders = true,
) {
  const parts = normalizeAssetPath(relativePath).split('/').filter(Boolean)
  const filename = parts.pop() || 'asset.bin'
  const targetDir = preserveFolders
    ? await getDirectoryForPath(targetRoot, parts, true)
    : targetRoot
  await ensurePermission(targetDir, 'readwrite')
  const targetFile = await targetDir.getFileHandle(filename, { create: true })
  const writable = await targetFile.createWritable()
  await writable.write(file)
  await writable.close()
}

export function normalizeAssetPath(value: string) {
  const trimmed = value.trim().replace(/^file:\/\//, '')
  const withoutQuery = trimmed.split(/[?#]/)[0]
  const decoded = safeDecode(withoutQuery)
  return decoded
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
}

export function normalizeLookupPath(value: string) {
  return normalizeAssetPath(value).toLocaleLowerCase()
}

export function getExtension(value: string) {
  const filename = value.split(/[?#]/)[0]
  const match = /\.([^./\\]+)$/.exec(filename)
  return match?.[1]?.toLocaleLowerCase() ?? ''
}

export function dirname(path: string) {
  const parts = normalizeAssetPath(path).split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

export function joinPath(...parts: string[]) {
  return normalizeAssetPath(parts.filter(Boolean).join('/'))
}

export function stableId(value: string) {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index)
  }
  return `ab_${(hash >>> 0).toString(36)}`
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
