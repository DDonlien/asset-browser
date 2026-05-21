import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Box,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  Grid2X2,
  Image as ImageIcon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu'
import { Input } from './components/ui/input'
import { PreviewPane } from './components/PreviewPane'
import { ScrollArea } from './components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip'
import {
  buildFileIndex,
  copyFileToDirectory,
  deleteFileAtPath,
  ensurePermission,
  dirname,
  findManifestFiles,
  getExtension,
  getFileHandleAtPath,
  inspectDirectoryWorkload,
  normalizeLookupPath,
  pickDirectory,
  readJsonFile,
  renameFileAtPath,
  stableId,
  supportsFileSystemAccess,
  writeJsonFile,
} from './lib/fileSystem'
import {
  hydrateIndexAssets,
  INDEX_FILENAME,
  syncIndexDocument,
} from './lib/indexDocument'
import {
  GENERATED_MANIFEST_FILENAME,
  writeGeneratedCsvManifest,
} from './lib/generatedManifest'
import { getKindLabel, isExternalReference } from './lib/manifest'
import {
  addHistory,
  loadLocalState,
  normalizeState,
  recordRename,
  saveLocalState,
  setAssetRating,
  setAssetTags,
  STATE_FILENAME,
  touchState,
} from './lib/state'
import type {
  ActivityItem,
  AppStateDoc,
  AssetKind,
  AssetRecord,
  IndexedFile,
  ManifestSource,
} from './types'
import { createTemplateAssets } from './lib/templateAssets'
import { cn } from './lib/utils'

type FileIndex = Awaited<ReturnType<typeof buildFileIndex>>
type KindFilter = AssetKind | 'all'
type FilterGroup = 'type' | 'filetype' | 'tag' | 'collection' | 'rating'
type SortKey =
  | 'name'
  | 'type'
  | 'filetype'
  | 'size'
  | 'createdAt'
  | 'updatedAt'
  | 'rating'
  | 'tag'
type SortDirection = 'asc' | 'desc'
type SortState = { key: SortKey; direction: SortDirection } | null
type FolderTreeNode = {
  name: string
  path: string
  parentPath: string
  count: number
  depth: number
  hasChildren: boolean
}

const EMPTY_FILE_INDEX: FileIndex = {
  byPath: new Map(),
  byBasename: new Map(),
}

const KIND_FILTERS: KindFilter[] = [
  'all',
  'image',
  'audio',
  'video',
  'model',
  'document',
  'unknown',
]

const ASSET_KIND_FILTERS = KIND_FILTERS.filter(
  (kind): kind is AssetKind => kind !== 'all',
)
const RATING_FILTERS = [5, 4, 3, 2, 1]

const INDEX_SOURCE_ID = '__asset-browser-index__'
const ASSET_ROW_HEIGHT = 56
const ASSET_VIRTUAL_OVERSCAN = 8
const KIND_ICON_COMPONENTS: Record<AssetKind, typeof ImageIcon> = {
  image: ImageIcon,
  audio: FileAudio,
  video: FileVideo,
  model: Box,
  document: FileText,
  unknown: CircleHelp,
}

function App() {
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(
    null,
  )
  const [rootName, setRootName] = useState('')
  const [targetHandle, setTargetHandle] =
    useState<FileSystemDirectoryHandle | null>(null)
  const [, setManifests] = useState<ManifestSource[]>([])
  const [, setActiveManifestId] = useState('')
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [focusedId, setFocusedId] = useState('')
  const [sourcePanelCollapsed, setSourcePanelCollapsed] = useState(false)
  const [activityCollapsed, setActivityCollapsed] = useState(true)
  const [expandedFilterGroups, setExpandedFilterGroups] = useState<FilterGroup[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [selectedFolderPath, setSelectedFolderPath] = useState('')
  const [folderSectionCollapsed, setFolderSectionCollapsed] = useState(false)
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState<Set<string>>(
    () => new Set(),
  )
  const [statusFilter, setStatusFilter] = useState<AssetRecord['status'] | ''>('')
  const [sortState, setSortState] = useState<SortState>(null)
  const [assetScrollState, setAssetScrollState] = useState({
    key: '',
    top: 0,
    height: 720,
  })
  const [fileIndex, setFileIndex] = useState<Map<string, IndexedFile>>(new Map())
  const [selectedKindFilters, setSelectedKindFilters] = useState<AssetKind[]>([])
  const [selectedFileTypeFilters, setSelectedFileTypeFilters] = useState<string[]>([])
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([])
  const [selectedCollectionFilters, setSelectedCollectionFilters] = useState<string[]>([])
  const [selectedRatingFilters, setSelectedRatingFilters] = useState<number[]>([])
  const [stateDoc, setStateDoc] = useState<AppStateDoc>(() => loadLocalState())
  const [metadataReady, setMetadataReady] = useState(false)
  const [busy, setBusy] = useState('')
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [tagComposerAssetId, setTagComposerAssetId] = useState('')
  const [tagComposerValue, setTagComposerValue] = useState('')
  const [tableScrollState, setTableScrollState] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  })
  const lastMetadataSaveRef = useRef('')
  const resolvingAssetIdsRef = useRef(new Set<string>())
  const tableScrollRef = useRef<HTMLDivElement | null>(null)

  const templateAssets = useMemo(() => createTemplateAssets(), [])
  const sourceAssets = assets.length > 0 ? assets : templateAssets
  const focusedAsset = sourceAssets.find((asset) => asset.id === focusedId)
  const tagOptions = useMemo(() => {
    const tags = new Set<string>()
    sourceAssets.forEach((asset) => {
      asset.tags.forEach((tag) => tags.add(tag))
      stateDoc.assetTags[asset.id]?.forEach((tag) => tags.add(tag))
    })
    return Array.from(tags).sort((a, b) => a.localeCompare(b))
  }, [sourceAssets, stateDoc.assetTags])

  const fileTypeOptions = useMemo(() => {
    const extensions = new Set<string>()
    sourceAssets.forEach((asset) => {
      if (selectedKindFilters.length > 0 && !selectedKindFilters.includes(asset.kind)) {
        return
      }
      const extension = String(asset.extension ?? '')
        .replace(/^\./, '')
        .trim()
        .toLocaleLowerCase()
      if (!extension) return
      extensions.add(extension)
    })
    return Array.from(extensions).sort((a, b) => a.localeCompare(b))
  }, [sourceAssets, selectedKindFilters])

  const activeFileTypeFilters = useMemo(
    () => selectedFileTypeFilters.filter((extension) => fileTypeOptions.includes(extension)),
    [fileTypeOptions, selectedFileTypeFilters],
  )

  const collectionAssetIds = useMemo(() => {
    const selected = stateDoc.favorites.filter((collection) =>
      selectedCollectionFilters.includes(collection.id),
    )
    return new Set(selected.flatMap((collection) => collection.entries.map((entry) => entry.id)))
  }, [selectedCollectionFilters, stateDoc.favorites])

  const filteredAssets = useMemo(() => {
    const terms = query
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean)

    return sourceAssets.filter((asset) => {
      if (selectedFolderPath) {
        const assetFolder = asset.folder || 'root'
        const inFolder =
          selectedFolderPath === 'root'
            ? assetFolder === 'root'
            : assetFolder === selectedFolderPath ||
              assetFolder.startsWith(`${selectedFolderPath}/`)
        if (!inFolder) return false
      }
      if (statusFilter && asset.status !== statusFilter) return false
      if (
        selectedKindFilters.length > 0 &&
        !selectedKindFilters.includes(asset.kind)
      ) {
        return false
      }
      if (
        selectedCollectionFilters.length > 0 &&
        !collectionAssetIds.has(asset.id)
      ) {
        return false
      }
      const assetTags = [
        ...asset.tags,
        ...(stateDoc.assetTags[asset.id] ?? []),
      ]
      if (
        selectedTagFilters.length > 0 &&
        !selectedTagFilters.every((tag) => assetTags.includes(tag))
      ) {
        return false
      }
      if (
        selectedRatingFilters.length > 0 &&
        !selectedRatingFilters.includes(stateDoc.assetRatings[asset.id] ?? 0)
      ) {
        return false
      }
      if (
        activeFileTypeFilters.length > 0 &&
        !activeFileTypeFilters.includes(
          String(asset.extension ?? '')
            .replace(/^\./, '')
            .trim()
            .toLocaleLowerCase(),
        )
      ) {
        return false
      }
      if (terms.length === 0) return true
      const haystack = [
        asset.name,
        asset.reference,
        asset.normalizedPath,
        asset.folder,
        asset.status,
        asset.typeLabel,
        asset.tags.join(' '),
        stateDoc.assetTags[asset.id]?.join(' ') ?? '',
        ...Object.values(asset.metadata),
      ]
        .join(' ')
        .toLocaleLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [
    sourceAssets,
    selectedKindFilters,
    selectedCollectionFilters,
    collectionAssetIds,
    selectedFolderPath,
    selectedTagFilters,
    selectedRatingFilters,
    activeFileTypeFilters,
    query,
    statusFilter,
    stateDoc.assetRatings,
    stateDoc.assetTags,
  ])

  const sourceOrder = useMemo(() => {
    const order = new Map<string, number>()
    sourceAssets.forEach((asset, index) => {
      order.set(asset.id, index)
    })
    return order
  }, [sourceAssets])

  const toggleSort = (key: SortKey) => {
    setSortState((current) => {
      if (!current || current.key !== key) return { key, direction: 'asc' }
      if (current.direction === 'asc') return { key, direction: 'desc' }
      return null
    })
  }

  const sortIndicator = (key: SortKey) => {
    if (!sortState || sortState.key !== key) return null
    return sortState.direction === 'asc' ? <ChevronUp /> : <ChevronDown />
  }

  const visibleAssets = useMemo(() => {
    if (!sortState) return filteredAssets

    const getDisplayTags = (asset: AssetRecord) =>
      Array.from(
        new Set([...asset.tags, ...(stateDoc.assetTags[asset.id] ?? [])]),
      )

    const compareText = (a: string, b: string) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

    const compareOptionalNumber = (
      a: number | undefined,
      b: number | undefined,
    ) => {
      if (a == null && b == null) return 0
      if (a == null) return 1
      if (b == null) return -1
      return a - b
    }

    const compareOptionalText = (a: string | undefined, b: string | undefined) => {
      if (!a && !b) return 0
      if (!a) return 1
      if (!b) return -1
      return compareText(a, b)
    }

    const direction = sortState.direction === 'asc' ? 1 : -1

    const sorted = [...filteredAssets].sort((left, right) => {
      let result = 0
      switch (sortState.key) {
        case 'name':
          result = compareText(left.name, right.name)
          break
        case 'type':
          result = compareText(left.kind, right.kind)
          break
        case 'filetype':
          result = compareOptionalText(left.extension, right.extension)
          break
        case 'size':
          result = compareOptionalNumber(left.size, right.size)
          break
        case 'createdAt':
          result = compareOptionalNumber(left.createdAt, right.createdAt)
          break
        case 'updatedAt':
          result = compareOptionalNumber(left.updatedAt, right.updatedAt)
          break
        case 'rating':
          result = (stateDoc.assetRatings[left.id] ?? 0) - (stateDoc.assetRatings[right.id] ?? 0)
          break
        case 'tag':
          result = compareText(getDisplayTags(left).join(' '), getDisplayTags(right).join(' '))
          break
      }

      if (result !== 0) return result * direction
      return (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0)
    })

    return sorted
  }, [filteredAssets, sortState, sourceOrder, stateDoc.assetRatings, stateDoc.assetTags])

  const workspaceClassName = cn('workspace', 'is-list-only')
  const visibleAssetIds = useMemo(
    () => visibleAssets.map((asset) => asset.id),
    [visibleAssets],
  )
  const virtualScopeKey = [
    query,
    selectedFolderPath,
    statusFilter,
    selectedKindFilters.join(','),
    activeFileTypeFilters.join(','),
    selectedCollectionFilters.join(','),
    selectedTagFilters.join(','),
    selectedRatingFilters.join(','),
    sortState ? `${sortState.key}:${sortState.direction}` : '',
    sourceAssets.length,
  ].join('|')
  const assetScrollTop =
    assetScrollState.key === virtualScopeKey ? assetScrollState.top : 0
  const assetViewportHeight =
    assetScrollState.key === virtualScopeKey ? assetScrollState.height : 720
  const tableScrollStateForScope =
    assetScrollState.key === virtualScopeKey
      ? tableScrollState
      : { canScrollLeft: false, canScrollRight: false }
  const virtualStartIndex = Math.max(
    0,
    Math.floor(assetScrollTop / ASSET_ROW_HEIGHT) - ASSET_VIRTUAL_OVERSCAN,
  )
  const virtualEndIndex = Math.min(
    visibleAssets.length,
    Math.ceil((assetScrollTop + assetViewportHeight) / ASSET_ROW_HEIGHT) +
      ASSET_VIRTUAL_OVERSCAN,
  )
  const renderedAssets = useMemo(
    () => visibleAssets.slice(virtualStartIndex, virtualEndIndex),
    [virtualEndIndex, virtualStartIndex, visibleAssets],
  )
  const virtualTopHeight = virtualStartIndex * ASSET_ROW_HEIGHT
  const virtualBottomHeight =
    Math.max(visibleAssets.length - virtualEndIndex, 0) * ASSET_ROW_HEIGHT
  const selectedAssets = useMemo(
    () => sourceAssets.filter((asset) => selectedIds.has(asset.id)),
    [selectedIds, sourceAssets],
  )
  const folderTreeNodes = useMemo(() => {
    const folderCounts = new Map<string, number>()
    const folderPaths = new Set<string>()
    const childrenByParent = new Map<string, string[]>()

    const getParentPath = (path: string) => {
      if (path === 'root') return ''
      const parts = path.split('/').filter(Boolean)
      if (parts.length <= 1) return ''
      return parts.slice(0, -1).join('/')
    }

    const addFolderPath = (path: string) => {
      folderPaths.add(path)
      const parentPath = getParentPath(path)
      if (!parentPath) return
      const children = childrenByParent.get(parentPath) ?? []
      if (!children.includes(path)) {
        children.push(path)
        childrenByParent.set(parentPath, children)
      }
    }

    sourceAssets.forEach((asset) => {
      const folder = asset.folder || 'root'

      if (folder === 'root') {
        addFolderPath('root')
        folderCounts.set('root', (folderCounts.get('root') ?? 0) + 1)
        return
      }

      const parts = folder.split('/').filter(Boolean)
      parts.forEach((_, index) => {
        const path = parts.slice(0, index + 1).join('/')
        addFolderPath(path)
        folderCounts.set(path, (folderCounts.get(path) ?? 0) + 1)
      })
    })

    const makeNode = (path: string): FolderTreeNode => {
      const parts = path === 'root' ? ['root'] : path.split('/').filter(Boolean)
      return {
        name: parts[parts.length - 1] ?? path,
        path,
        parentPath: getParentPath(path),
        count: folderCounts.get(path) ?? 0,
        depth: path === 'root' ? 0 : parts.length - 1,
        hasChildren: (childrenByParent.get(path)?.length ?? 0) > 0,
      }
    }

    const sortPaths = (left: string, right: string) => {
      if (left === 'root') return -1
      if (right === 'root') return 1
      return left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    }

    const sortedChildrenByParent = new Map(
      Array.from(childrenByParent, ([parent, children]) => [
        parent,
        [...children].sort(sortPaths),
      ]),
    )
    const topLevelPaths = Array.from(folderPaths)
      .filter((path) => !getParentPath(path))
      .sort(sortPaths)
    const orderedNodes: FolderTreeNode[] = []
    const appendPath = (path: string) => {
      orderedNodes.push(makeNode(path))
      sortedChildrenByParent.get(path)?.forEach(appendPath)
    }

    topLevelPaths.forEach(appendPath)
    return orderedNodes
  }, [sourceAssets])
  const folderNodeByPath = useMemo(
    () => new Map(folderTreeNodes.map((node) => [node.path, node])),
    [folderTreeNodes],
  )
  const visibleFolderTreeNodes = useMemo(() => {
    if (folderSectionCollapsed) return []

    return folderTreeNodes.filter((node) => {
      let parentPath = node.parentPath
      while (parentPath) {
        if (collapsedFolderPaths.has(parentPath)) return false
        parentPath = folderNodeByPath.get(parentPath)?.parentPath ?? ''
      }
      return true
    })
  }, [
    collapsedFolderPaths,
    folderNodeByPath,
    folderSectionCollapsed,
    folderTreeNodes,
  ])
  const toggleFolderCollapsed = useCallback((path: string) => {
    setCollapsedFolderPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])
  const selectedFilteredCount = visibleAssetIds.filter((id) =>
    selectedIds.has(id),
  ).length
  const allFilteredSelected =
    visibleAssetIds.length > 0 && selectedFilteredCount === visibleAssetIds.length

  useEffect(() => {
    saveLocalState(stateDoc)
  }, [stateDoc])

  useEffect(() => {
    if (!rootHandle || !metadataReady) return

    const nextMetadata = touchState({
      ...stateDoc,
      sourceRootName: rootName || stateDoc.sourceRootName,
    })
    const serialized = JSON.stringify(nextMetadata, null, 2)
    if (serialized === lastMetadataSaveRef.current) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        if (rootHandle.queryPermission) {
          const writePermission = await rootHandle.queryPermission({
            mode: 'readwrite',
          })
          if (writePermission !== 'granted') return false
        }
        await writeJsonFile(rootHandle, STATE_FILENAME, nextMetadata)
        return true
      })()
        .then((saved) => {
          if (saved) lastMetadataSaveRef.current = serialized
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setActivity((items) => [
            {
              id: stableId(`${Date.now()}:metadata-save-failed`),
              level: 'fail' as const,
              message:
                error instanceof Error
                  ? `保存 ${STATE_FILENAME} 失败：${error.message}`
                  : `保存 ${STATE_FILENAME} 失败。`,
              time: new Date().toLocaleTimeString(),
            },
            ...items,
          ].slice(0, 80))
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [metadataReady, rootHandle, rootName, stateDoc])

  const log = (level: ActivityItem['level'], message: string) => {
    setActivity((items) => [
      {
        id: stableId(`${Date.now()}:${message}`),
        level,
        message,
        time: new Date().toLocaleTimeString(),
      },
      ...items,
    ].slice(0, 80))
  }

  const handlePickerError = (error: unknown, fallback: string) => {
    if (isUserAbort(error)) {
      log('info', '已取消选择。')
      return
    }
    log('fail', error instanceof Error ? error.message : fallback)
  }

  const chooseRoot = async () => {
    let root: FileSystemDirectoryHandle
    try {
      setBusy('Opening folder')
      root = await pickDirectory('read')
      setRootHandle(root)
      setRootName(root.name)
      setManifests([])
      setAssets([])
      setFocusedId('')
      setSelectedIds(new Set())
      setActiveManifestId('')
      setFileIndex(new Map())
      log('info', `已选择文件夹：${root.name}，正在检查根目录索引文件。`)
      setBusy('Checking index')
    } catch (error) {
      handlePickerError(error, '选择目录失败。')
      setBusy('')
      return
    }

    try {
      setMetadataReady(false)
      lastMetadataSaveRef.current = ''
      const nextManifests = await findManifestFiles(root)
      const nextIndex = EMPTY_FILE_INDEX
      setManifests(nextManifests)
      setFileIndex(new Map())

      try {
        const saved = await readJsonFile<AppStateDoc>(root, STATE_FILENAME)
        const normalized = normalizeState(saved)
        setStateDoc(normalized)
        lastMetadataSaveRef.current = JSON.stringify(normalized, null, 2)
        log('success', `读取 ${STATE_FILENAME}`)
      } catch {
        setStateDoc((current) =>
          touchState({ ...current, sourceRootName: root.name }),
        )
      }

      await loadIndexForRoot(root, nextManifests, nextIndex, root.name, {
        persistIndex: false,
        resolveFiles: false,
      })
      setMetadataReady(true)
    } catch (error) {
      log(
        'fail',
        error instanceof Error
          ? `目录已选择，但读取失败：${error.message}`
          : '目录已选择，但读取失败。',
      )
    } finally {
      setBusy('')
    }
  }

  const loadIndexForRoot = async (
    root: FileSystemDirectoryHandle,
    nextManifests: ManifestSource[],
    index: FileIndex,
    sourceRootName: string,
    options: { persistIndex?: boolean; resolveFiles?: boolean } = {},
  ) => {
    setBusy(`Checking ${INDEX_FILENAME}`)
    const result = await syncIndexDocument(root, sourceRootName, nextManifests, index, {
      persist: options.persistIndex ?? true,
      resolveFiles: options.resolveFiles ?? true,
    })
    const hydrated = await Promise.all(
      hydrateIndexAssets(result.doc, index, {
        resolveFiles: options.resolveFiles ?? true,
      }).map(hydrateAsset),
    )
    setAssets(hydrated)
    setFocusedId('')
    setActiveManifestId(INDEX_SOURCE_ID)
    setStateDoc((current) =>
      touchState({
        ...current,
        sourceRootName,
        activeManifestName: INDEX_FILENAME,
      }),
    )
    logIndexResult(
      result.status,
      result.reason,
      hydrated.length,
      true,
      {
        writeError: result.writeError,
        writeSkipped: result.writeSkipped,
      },
      {
        rootName: sourceRootName,
        sourceNames: result.doc.manifestSources.map((source) => source.name),
      },
    )
    setBusy('')
  }

  const logIndexResult = (
    status: 'created' | 'updated' | 'loaded' | 'empty',
    reason: string,
    assetCount: number,
    loadingIndex = false,
    writeState: { writeError?: string; writeSkipped?: boolean } = {},
    context: { rootName?: string; sourceNames?: string[] } = {},
  ) => {
    const rootLabel = context.rootName ? `${context.rootName}；` : ''
    const sourceList = context.sourceNames?.length
      ? context.sourceNames.join('、')
      : INDEX_FILENAME
    if (status === 'empty') {
      log(
        'warn',
        `已打开文件夹：${rootLabel}根目录没有找到 asset-browser-index.json、asset-browser-index.csv 或 asset-browser-index.xlsx。`,
      )
      return
    }
    if (status === 'loaded') {
      log(
        'success',
        loadingIndex
          ? `已打开文件夹：${rootLabel}找到 ${INDEX_FILENAME}，读取 ${assetCount} 个资产。`
          : `${INDEX_FILENAME} 已是最新，未修改。`,
      )
      return
    }
    if (loadingIndex && (writeState.writeSkipped || writeState.writeError)) {
      log(
        writeState.writeSkipped ? 'success' : 'warn',
        writeState.writeSkipped
          ? `已打开文件夹：${rootLabel}找到 ${sourceList}，读取 ${assetCount} 个资产；${INDEX_FILENAME} 仅在内存中生成，未请求写入磁盘权限。`
          : `已打开文件夹：${rootLabel}找到 ${sourceList}，读取 ${assetCount} 个资产；写入 ${INDEX_FILENAME} 失败：${writeState.writeError}`,
      )
      return
    }
    log(
      'success',
      `已打开文件夹：${rootLabel}找到 ${sourceList}，${status === 'created' ? '生成' : '更新'} ${INDEX_FILENAME}：${reason}，${assetCount} 个资产。`,
    )
  }

  const hydrateAsset = async (asset: AssetRecord): Promise<AssetRecord> => {
    if (!asset.fileHandle) return asset
    try {
      const file = await asset.fileHandle.getFile()
      return {
        ...asset,
        size: file.size,
        mime: file.type,
        createdAt: asset.createdAt ?? file.lastModified,
        updatedAt: file.lastModified,
      }
    } catch {
      return { ...asset, status: 'missing' }
    }
  }

  const readAssetFileHandle = useCallback(async (asset: AssetRecord) => {
    if (!rootHandle || asset.fileHandle || asset.isExternal) return asset
    const targetPath = asset.normalizedPath || asset.reference
    if (!targetPath) return asset

    try {
      const fileHandle = await getFileHandleAtPath(rootHandle, targetPath)
      const file = await fileHandle.getFile()
      const nextAsset: AssetRecord = {
        ...asset,
        fileHandle,
        status: 'ready',
        size: file.size,
        mime: file.type,
        createdAt: asset.createdAt ?? file.lastModified,
        updatedAt: file.lastModified,
      }
      return nextAsset
    } catch {
      return { ...asset, status: 'missing' } satisfies AssetRecord
    }
  }, [rootHandle])

  const focusAsset = (asset: AssetRecord) => {
    setFocusedId(asset.id)
    setStateDoc((current) => addHistory(current, asset))
  }

  const toggleSelected = (assetId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  const toggleFilteredSelection = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allFilteredSelected) {
        visibleAssetIds.forEach((id) => next.delete(id))
      } else {
        visibleAssetIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const activateAsset = (asset: AssetRecord) => {
    if (focusedId === asset.id) {
      setFocusedId('')
      return
    }
    focusAsset(asset)
  }

  const deleteAsset = async (asset: AssetRecord) => {
    if (!rootHandle || !asset.fileHandle || asset.status !== 'ready') return
    if (!window.confirm(`删除 ${asset.name}？`)) return
    try {
      setBusy('Deleting')
      await deleteFileAtPath(rootHandle, asset.normalizedPath)
      setAssets((items) => items.filter((item) => item.id !== asset.id))
      setSelectedIds((current) => {
        const next = new Set(current)
        next.delete(asset.id)
        return next
      })
      setFocusedId((current) => (current === asset.id ? '' : current))
      log('success', `删除完成：${asset.name}`)
    } catch (error) {
      log('fail', error instanceof Error ? error.message : '删除失败。')
    } finally {
      setBusy('')
    }
  }

  const renameAsset = async (asset: AssetRecord) => {
    if (!rootHandle || !asset.fileHandle || asset.status !== 'ready') return
    const proposed = window.prompt('重命名为：', asset.name)
    if (proposed == null) return
    const nextName = proposed.trim()
    if (!nextName || nextName === asset.name) return

    if (assets.length === 0) {
      log('warn', '模板资源暂不支持重命名。请先打开真实文件夹。')
      return
    }

    try {
      setBusy('Renaming')
      const nextPath = await renameFileAtPath(rootHandle, asset.normalizedPath, nextName)
      const nextIndex = await buildFileIndex(rootHandle)
      const nextHandle = nextIndex.byPath.get(normalizeLookupPath(nextPath))?.handle
      setFileIndex(nextIndex.byPath)
      setAssets((items) =>
        items.map((item) =>
          item.id === asset.id
            ? {
                ...item,
                name: nextName,
                reference: nextPath,
                normalizedPath: nextPath,
                folder: dirname(nextPath) || 'root',
                extension: getExtension(nextPath),
                fileHandle: nextHandle,
              }
            : item,
        ),
      )
      setStateDoc((current) => recordRename(current, asset, nextPath))
      log('success', `重命名完成：${asset.name} -> ${nextName}`)
    } catch (error) {
      log('fail', error instanceof Error ? error.message : '重命名失败。')
    } finally {
      setBusy('')
    }
  }

  const downloadAsset = async (asset: AssetRecord) => {
    try {
      setBusy('Downloading')
      const target = targetHandle ?? (await pickDirectory('readwrite'))
      setTargetHandle(target)
      if (asset.previewUrl) {
        const response = await fetch(asset.previewUrl)
        await copyFileToDirectory(
          target,
          asset.normalizedPath || asset.name,
          await response.blob(),
        )
      } else if (asset.isExternal && isExternalReference(asset.reference)) {
        const response = await fetch(asset.reference)
        if (!response.ok) throw new Error(response.statusText)
        await copyFileToDirectory(
          target,
          asset.normalizedPath || asset.name,
          await response.blob(),
        )
      } else if (asset.fileHandle) {
        await copyFileToDirectory(
          target,
          asset.normalizedPath,
          await asset.fileHandle.getFile(),
        )
      } else {
        throw new Error('这个资产没有可下载的文件引用。')
      }
      log('success', `下载到目标目录：${asset.name}`)
    } catch (error) {
      handlePickerError(error, '下载失败。')
    } finally {
      setBusy('')
    }
  }

  const updateAssetRating = (asset: AssetRecord, rating: number) => {
    const current = stateDoc.assetRatings[asset.id] ?? 0
    const nextRating = current === rating ? 0 : rating
    setStateDoc((currentState) => setAssetRating(currentState, asset, nextRating))
    log(
      'success',
      nextRating > 0
        ? `评分：${asset.name} -> ${nextRating}`
        : `清空评分：${asset.name}`,
    )
  }

  const setFilterGroupOpen = (group: FilterGroup, open: boolean) => {
    setExpandedFilterGroups((current) => {
      if (open) return current.includes(group) ? current : [...current, group]
      return current.filter((item) => item !== group)
    })
  }

  const removeAssetTag = (asset: AssetRecord, tag: string) => {
    const currentTags = stateDoc.assetTags[asset.id] ?? []
    if (!currentTags.includes(tag)) return
    const nextTags = currentTags.filter((item) => item !== tag)
    setStateDoc((current) => setAssetTags(current, asset, nextTags))
    log('success', `移除标签：${asset.name} -> ${tag}`)
  }

  const addAssetTag = (asset: AssetRecord, tag: string) => {
    const nextTag = tag.trim()
    if (!nextTag) return
    const currentTags = stateDoc.assetTags[asset.id] ?? []
    const nextTags = Array.from(new Set([...currentTags, nextTag]))
    setStateDoc((current) => setAssetTags(current, asset, nextTags))
    log('success', `新增标签：${asset.name} -> ${nextTag}`)
  }

  const updateTableScrollState = () => {
    const element = tableScrollRef.current
    if (!element) return
    const maxScrollLeft = element.scrollWidth - element.clientWidth
    setTableScrollState({
      canScrollLeft: element.scrollLeft > 2,
      canScrollRight: element.scrollLeft < maxScrollLeft - 2,
    })
  }

  useEffect(() => {
    updateTableScrollState()
  }, [focusedAsset, visibleAssets.length])

  useLayoutEffect(() => {
    const element = tableScrollRef.current
    if (!element) return

    element.scrollLeft = 0
    const id = window.requestAnimationFrame(() => {
      setAssetScrollState({
        key: virtualScopeKey,
        top: 0,
        height: element.clientHeight || 720,
      })
      updateTableScrollState()
    })
    return () => window.cancelAnimationFrame(id)
  }, [virtualScopeKey])

  useEffect(() => {
    const element = tableScrollRef.current
    if (!element) return
    const id = window.requestAnimationFrame(() => {
      updateTableScrollState()
    })
    return () => window.cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    if (!rootHandle || assets.length === 0) return

    const candidates = renderedAssets.filter((asset) => {
      if (asset.fileHandle || asset.isExternal || asset.status === 'missing') {
        return false
      }
      if (!asset.normalizedPath && !asset.reference) return false
      if (resolvingAssetIdsRef.current.has(asset.id)) return false
      return true
    })

    if (candidates.length === 0) return

    let cancelled = false
    candidates.forEach((asset) => resolvingAssetIdsRef.current.add(asset.id))

    void Promise.all(candidates.map((asset) => readAssetFileHandle(asset)))
      .then((resolvedAssets) => {
        if (cancelled) return
        const resolvedById = new Map(
          resolvedAssets.map((asset) => [asset.id, asset]),
        )
        setAssets((items) =>
          items.map((item) => resolvedById.get(item.id) ?? item),
        )
      })
      .finally(() => {
        candidates.forEach((asset) => resolvingAssetIdsRef.current.delete(asset.id))
      })

    return () => {
      cancelled = true
    }
  }, [assets.length, readAssetFileHandle, renderedAssets, rootHandle])

  const resetFilters = () => {
    setQuery('')
    setSelectedFolderPath('')
    setStatusFilter('')
    setSelectedKindFilters([])
    setSelectedFileTypeFilters([])
    setSelectedTagFilters([])
    setSelectedCollectionFilters([])
    setSelectedRatingFilters([])
    setExpandedFilterGroups([])
  }

  const generateIndex = async () => {
    if (!rootHandle) {
      await chooseRoot()
      return
    }

    try {
      setBusy('Generating index')
      log('info', `开始生成索引：先检查根目录 ${GENERATED_MANIFEST_FILENAME}。`)
      const canWrite = await ensurePermission(rootHandle, 'readwrite')
      if (!canWrite) throw new Error('没有获得该文件夹的写入权限。')
      let nextManifests = await findManifestFiles(rootHandle)
      let nextIndex = EMPTY_FILE_INDEX
      let shouldResolveFiles = false

      if (nextManifests.length === 0) {
        log('info', '根目录没有 CSV / Excel 索引，开始快速检查文件夹层级。')
        const workload = await inspectDirectoryWorkload(rootHandle)
        const topLevelPreview = workload.topLevelDirectories.slice(0, 4).join('、')
        log(
          'info',
          `预检查完成：约 ${workload.files} 个文件，${workload.directories} 个文件夹，最大深度 ${workload.maxDepth} 层${
            topLevelPreview ? `；一级目录：${topLevelPreview}` : ''
          }。`,
        )
        log('info', '开始扫描资产路径并建立索引。')
        let lastScanLogFiles = 0
        let lastScanLogDirectories = 0
        nextIndex = await buildFileIndex(rootHandle, {
          onProgress: (progress) => {
            const shouldLog =
              progress.files === 1 ||
              progress.files === workload.files ||
              progress.files - lastScanLogFiles >= 100 ||
              progress.directories - lastScanLogDirectories >= 25
            if (!shouldLog) return
            lastScanLogFiles = progress.files
            lastScanLogDirectories = progress.directories
            log(
              'info',
              `扫描进度：已发现 ${progress.files}/${workload.files} 个文件，${progress.directories} 个文件夹。`,
            )
          },
        })
        log('info', `扫描完成：准备写入 ${GENERATED_MANIFEST_FILENAME}。`)
        const generatedCount = await writeGeneratedCsvManifest(
          rootHandle,
          nextIndex,
          {
            onProgress: (progress) => {
              log(
                'info',
                `CSV 生成进度：${progress.processed}/${progress.total}。`,
              )
            },
          },
        )
        log(
          'success',
          `生成 ${GENERATED_MANIFEST_FILENAME}：扫描到 ${generatedCount} 个资产。`,
        )
        nextManifests = await findManifestFiles(rootHandle)
        shouldResolveFiles = true
      } else {
        log('info', `找到 ${nextManifests.map((item) => item.name).join('、')}，将基于现有索引更新 JSON。`)
      }

      setManifests(nextManifests)
      setFileIndex(shouldResolveFiles ? nextIndex.byPath : new Map())
      await loadIndexForRoot(rootHandle, nextManifests, nextIndex, rootName, {
        resolveFiles: shouldResolveFiles,
      })
    } catch (error) {
      log('fail', error instanceof Error ? error.message : '生成索引失败。')
    } finally {
      setBusy('')
    }
  }

  const downloadSelectedAssets = async () => {
    for (const asset of selectedAssets) {
      await downloadAsset(asset)
    }
  }

  const deleteSelectedAssets = async () => {
    for (const asset of selectedAssets) {
      await deleteAsset(asset)
    }
  }

  const loadMetadataManually = async () => {
    try {
      const directory = rootHandle ?? (await pickDirectory('read'))
      const next = await readJsonFile<AppStateDoc>(directory, STATE_FILENAME)
      setStateDoc(normalizeState(next))
      log('success', `载入 ${STATE_FILENAME}`)
    } catch (error) {
      handlePickerError(error, `没有找到 ${STATE_FILENAME}。`)
    }
  }

  return (
    <TooltipProvider>
    <motion.main
      className={cn('shell', sourcePanelCollapsed && 'is-panel-collapsed')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      <nav className="nav-rail" aria-label="Primary">
        <Button
          className={cn(
            'nav-item nav-logo',
            sourcePanelCollapsed ? 'is-collapsed' : 'is-expanded'
          )}
          variant="ghost"
          type="button"
          title={sourcePanelCollapsed ? '展开 Asset Browser' : '收起 Asset Browser'}
          aria-label={sourcePanelCollapsed ? '展开 Asset Browser' : '收起 Asset Browser'}
          onClick={() => setSourcePanelCollapsed((value) => !value)}
        >
          {sourcePanelCollapsed ? <ChevronsRight /> : <ChevronsLeft />}
        </Button>
      </nav>

      <AnimatePresence initial={false}>
      {!sourcePanelCollapsed && (
      <motion.aside
        className="panel"
        initial={{ x: -16, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: -16, opacity: 0 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
      >
        <div className="brand">
          {rootHandle ? (
            <>
              <div className="open-folder-title">
                <FolderOpen data-icon="inline-start" />
                <span>{rootName}</span>
              </div>
              <div className="brand-actions">
                <ToolbarIconButton
                  label="打开新文件夹"
                  onClick={chooseRoot}
                  disabled={!supportsFileSystemAccess() || Boolean(busy)}
                >
                  <FolderOpen />
                </ToolbarIconButton>
                <ToolbarIconButton
                  label="收起资源面板"
                  onClick={() => setSourcePanelCollapsed(true)}
                >
                  <ChevronsLeft />
                </ToolbarIconButton>
              </div>
            </>
          ) : (
            <>
              <Button
                className="open-folder-wide"
                type="button"
                onClick={chooseRoot}
                disabled={!supportsFileSystemAccess() || Boolean(busy)}
              >
                <FolderOpen data-icon="inline-start" />
                Open folder
              </Button>
              <ToolbarIconButton
                label="收起资源面板"
                onClick={() => setSourcePanelCollapsed(true)}
              >
                <ChevronsLeft />
              </ToolbarIconButton>
            </>
          )}
        </div>

        <ScrollArea className="panel-body">
          <section className="panel-nav-section">
            <Button
              className={cn(
                'panel-nav-row',
                !selectedFolderPath &&
                  !statusFilter &&
                  selectedCollectionFilters.length === 0 &&
                  'is-active',
              )}
              variant="ghost"
              type="button"
              onClick={resetFilters}
            >
              <Grid2X2 />
              <span>All Assets</span>
              <strong>{sourceAssets.length}</strong>
            </Button>
            <Button
              className={cn('panel-nav-row', statusFilter === 'missing' && 'is-active')}
              variant="ghost"
              type="button"
              onClick={() => {
                setSelectedFolderPath('')
                setStatusFilter((current) => (current === 'missing' ? '' : 'missing'))
              }}
            >
              <AlertTriangle />
              <span>Missing Source</span>
              <strong>{sourceAssets.filter((a) => a.status === 'missing').length}</strong>
            </Button>
            {busy && <Badge className="busy-chip" variant="secondary">{busy}</Badge>}
          </section>

          <section className="panel-nav-section panel-nav-folders">
            <button
              className="section-head folder-section-toggle"
              type="button"
              aria-expanded={!folderSectionCollapsed}
              onClick={() => setFolderSectionCollapsed((value) => !value)}
            >
              <h2>Folders</h2>
              {folderSectionCollapsed ? <ChevronRight /> : <ChevronDown />}
            </button>
            <div className="folder-list">
              {visibleFolderTreeNodes.map((item) => {
                const itemCollapsed = collapsedFolderPaths.has(item.path)
                const selectFolder = () => {
                  setStatusFilter('')
                  setSelectedFolderPath((current) =>
                    current === item.path ? '' : item.path,
                  )
                }

                return (
                  <div
                    key={item.path}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      'folder-row',
                      selectedFolderPath === item.path && 'is-active',
                      item.depth > 0 && 'is-nested',
                    )}
                    style={{ '--folder-depth': item.depth } as CSSProperties}
                    onClick={selectFolder}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      selectFolder()
                    }}
                  >
                    {item.hasChildren ? (
                      <button
                        className="folder-toggle"
                        type="button"
                        aria-label={itemCollapsed ? '展开子文件夹' : '收起子文件夹'}
                        aria-expanded={!itemCollapsed}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleFolderCollapsed(item.path)
                        }}
                      >
                        {itemCollapsed ? <ChevronRight /> : <ChevronDown />}
                      </button>
                    ) : (
                      <span className="folder-toggle is-leaf" aria-hidden="true">
                        <FolderOpen />
                      </span>
                    )}
                    <span>{item.name}</span>
                    <strong>{item.count}</strong>
                  </div>
                )
              })}
            </div>
          </section>
        </ScrollArea>
        <div className="panel-footer">
          <Button
            className="generate-index"
            type="button"
            variant="ghost"
            onClick={generateIndex}
            disabled={Boolean(busy) || !supportsFileSystemAccess()}
          >
            <RefreshCw data-icon="inline-start" />
            Generate Index
          </Button>
          {rootHandle && assets.length === 0 && (
            <Button type="button" variant="ghost" onClick={loadMetadataManually}>
              META
            </Button>
          )}
        </div>
      </motion.aside>
      )}
      </AnimatePresence>

      <section className="viewport">
        <div className={workspaceClassName}>
          <section
            className={cn('asset-list', focusedAsset && 'has-preview')}
            aria-label="Assets"
          >
        <div className="asset-list-toolbar">
          <div className="topbar-filters">
            <div className="topbar-search-row">
              <div className="topbar-search">
                <Search />
                <Input
                  value={query}
                  placeholder="Search name / type / path"
                  aria-label="Search assets"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
            <div className="topbar-search-divider" aria-hidden="true" />
            <div className="topbar-filter-row topbar-filter-row-all">
              <div className="topbar-filter-pills">
                <FilterGroupControl
                  title="Type"
                  count={selectedKindFilters.length}
                  selectedLabels={selectedKindFilters.map(getKindLabel)}
                  expanded={expandedFilterGroups.includes('type')}
                  onOpenChange={(open) => setFilterGroupOpen('type', open)}
                >
                  {ASSET_KIND_FILTERS.map((kind) => (
                    <FilterOptionButton
                      key={kind}
                      active={selectedKindFilters.includes(kind)}
                      onClick={() =>
                        setSelectedKindFilters((current) =>
                          toggleArrayValue(current, kind),
                        )
                      }
                    >
                      {getKindLabel(kind)}
                    </FilterOptionButton>
                  ))}
                </FilterGroupControl>
                <FilterGroupControl
                  title="FileType"
                  count={activeFileTypeFilters.length}
                  selectedLabels={activeFileTypeFilters.map((extension) => `.${extension}`)}
                  expanded={expandedFilterGroups.includes('filetype')}
                  onOpenChange={(open) => setFilterGroupOpen('filetype', open)}
                >
                  {fileTypeOptions.length > 0 ? (
                    fileTypeOptions.map((extension) => (
                      <FilterOptionButton
                        key={extension}
                        active={activeFileTypeFilters.includes(extension)}
                        onClick={() =>
                          setSelectedFileTypeFilters((current) =>
                            toggleArrayValue(current, extension),
                          )
                        }
                      >
                        .{extension}
                      </FilterOptionButton>
                    ))
                  ) : (
                    <span className="filter-empty">No file types</span>
                  )}
                </FilterGroupControl>
                <FilterGroupControl
                  title="Collection"
                  count={selectedCollectionFilters.length}
                  selectedLabels={selectedCollectionFilters.map(
                    (id) =>
                      stateDoc.favorites.find((collection) => collection.id === id)
                        ?.name ?? id,
                  )}
                  expanded={expandedFilterGroups.includes('collection')}
                  onOpenChange={(open) => setFilterGroupOpen('collection', open)}
                >
                  {stateDoc.favorites.map((collection) => (
                    <FilterOptionButton
                      key={collection.id}
                      active={selectedCollectionFilters.includes(collection.id)}
                      onClick={() =>
                        setSelectedCollectionFilters((current) =>
                          toggleArrayValue(current, collection.id),
                        )
                      }
                    >
                      {collection.name} ({collection.entries.length})
                    </FilterOptionButton>
                  ))}
                </FilterGroupControl>
                <FilterGroupControl
                  title="Rating"
                  count={selectedRatingFilters.length}
                  selectedLabels={selectedRatingFilters.map((rating) => `${rating} 分`)}
                  expanded={expandedFilterGroups.includes('rating')}
                  onOpenChange={(open) => setFilterGroupOpen('rating', open)}
                >
                  {RATING_FILTERS.map((rating) => (
                    <FilterOptionButton
                      key={rating}
                      active={selectedRatingFilters.includes(rating)}
                      onClick={() =>
                        setSelectedRatingFilters((current) =>
                          toggleArrayValue(current, rating),
                        )
                      }
                    >
                      {rating} 分
                    </FilterOptionButton>
                  ))}
                </FilterGroupControl>
                <FilterGroupControl
                  title="Tag"
                  count={selectedTagFilters.length}
                  selectedLabels={selectedTagFilters}
                  expanded={expandedFilterGroups.includes('tag')}
                  onOpenChange={(open) => setFilterGroupOpen('tag', open)}
                >
                  {tagOptions.length > 0 ? (
                    tagOptions.map((tag) => (
                      <FilterOptionButton
                        key={tag}
                        active={selectedTagFilters.includes(tag)}
                        onClick={() =>
                          setSelectedTagFilters((current) =>
                            toggleArrayValue(current, tag),
                          )
                        }
                      >
                        {tag}
                      </FilterOptionButton>
                    ))
                  ) : (
                    <span className="filter-empty">No tags</span>
                  )}
                </FilterGroupControl>
              </div>
              <Button
                className="reset-filters-icon"
                type="button"
                variant="outline"
                size="icon-sm"
                title="Reset"
                aria-label="Reset filters"
                onClick={resetFilters}
              >
                <RefreshCw />
              </Button>
            </div>
          </div>
        </div>
            <div
              className={cn(
                'asset-table-scroll',
                tableScrollStateForScope.canScrollLeft && 'can-scroll-left',
                tableScrollStateForScope.canScrollRight && 'can-scroll-right',
              )}
              ref={tableScrollRef}
              onScroll={(event) => {
                updateTableScrollState()
                setAssetScrollState({
                  key: virtualScopeKey,
                  top: event.currentTarget.scrollTop,
                  height: event.currentTarget.clientHeight,
                })
              }}
              onWheel={(event) => {
                const element = tableScrollRef.current
                if (!element) return
                const delta =
                  event.deltaX !== 0
                    ? event.deltaX
                    : event.shiftKey
                      ? event.deltaY
                      : 0
                if (!delta) return
                element.scrollLeft += delta
                updateTableScrollState()
                event.preventDefault()
              }}
            >
              <div className="asset-list-head">
                <span className="asset-select-head asset-sticky asset-sticky-select">
                  <Checkbox
                    className="select-checkbox"
                    checked={
                      allFilteredSelected
                        ? true
                        : selectedFilteredCount > 0
                          ? 'indeterminate'
                          : false
                    }
                    disabled={visibleAssetIds.length === 0}
                    aria-label="Select all visible assets"
                    onCheckedChange={toggleFilteredSelection}
                  />
                </span>
                <span className="asset-name-head asset-sticky asset-sticky-name">
                  <button
                    className="asset-head-button"
                    type="button"
                    onClick={() => toggleSort('name')}
                  >
                    <span>Name</span>
                    {sortIndicator('name')}
                  </button>
                </span>
                <span className="asset-middle-head">
                  <button
                    className="asset-head-button is-center"
                    type="button"
                    onClick={() => toggleSort('type')}
                  >
                    <span>Type</span>
                    {sortIndicator('type')}
                  </button>
                  <button
                    className="asset-head-button"
                    type="button"
                    onClick={() => toggleSort('filetype')}
                  >
                    <span>FileType</span>
                    {sortIndicator('filetype')}
                  </button>
                  <button
                    className="asset-head-button is-right"
                    type="button"
                    onClick={() => toggleSort('size')}
                  >
                    <span>Size</span>
                    {sortIndicator('size')}
                  </button>
                  <button
                    className="asset-head-button is-right"
                    type="button"
                    onClick={() => toggleSort('createdAt')}
                  >
                    <span>Created</span>
                    {sortIndicator('createdAt')}
                  </button>
                  <button
                    className="asset-head-button is-right"
                    type="button"
                    onClick={() => toggleSort('updatedAt')}
                  >
                    <span>Modified</span>
                    {sortIndicator('updatedAt')}
                  </button>
                  <button
                    className="asset-head-button"
                    type="button"
                    onClick={() => toggleSort('rating')}
                  >
                    <span>Rating</span>
                    {sortIndicator('rating')}
                  </button>
                  <button
                    className="asset-head-button"
                    type="button"
                    onClick={() => toggleSort('tag')}
                  >
                    <span>Tag</span>
                    {sortIndicator('tag')}
                  </button>
                </span>
                <span className="asset-actions-head asset-sticky asset-sticky-actions">
                  Actions
                </span>
              </div>
              <div
                key={virtualScopeKey}
                className="asset-rows"
              >
                <div
                  className="asset-virtual-spacer"
                  style={{ height: virtualTopHeight }}
                  aria-hidden="true"
                />
                {renderedAssets.map((asset) => (
                  (() => {
                    const displayTags = Array.from(new Set([
                      ...asset.tags,
                      ...(stateDoc.assetTags[asset.id] ?? []),
                    ]))
                    const removableTags = new Set(stateDoc.assetTags[asset.id] ?? [])
                    const composerOpen = tagComposerAssetId === asset.id

                    return (
                  <div
                    key={asset.id}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      'asset-row',
                      asset.id === focusedId && 'is-focused',
                      selectedIds.has(asset.id) && 'is-selected',
                    )}
                    onClick={() => {
                      activateAsset(asset)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        activateAsset(asset)
                      }
                    }}
                  >
                    <span className="asset-select-cell asset-sticky asset-sticky-select">
                      <Checkbox
                        className="row-check"
                        checked={selectedIds.has(asset.id)}
                        onClick={(event) => {
                          event.stopPropagation()
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                        }}
                        onCheckedChange={() => {
                          toggleSelected(asset.id)
                        }}
                        aria-label={`Select ${asset.name}`}
                      />
                    </span>
                    <span className="asset-name asset-sticky asset-sticky-name">
                      <strong>{asset.name}</strong>
                      <span
                        className="asset-path"
                        title={asset.normalizedPath || asset.reference}
                      >
                        {asset.normalizedPath || asset.reference}
                      </span>
                    </span>
                    <span className="asset-middle">
                      <KindIconBadge asset={asset} />
                      <span className="filetype-ext">{formatFileExtension(asset)}</span>
                      <span className="asset-size">{formatFileSize(asset.size)}</span>
                      <span
                        className="asset-date"
                        title={formatDateTime(asset.createdAt)}
                      >
                        {formatDateShort(asset.createdAt)}
                      </span>
                      <span
                        className="asset-date"
                        title={formatDateTime(asset.updatedAt)}
                      >
                        {formatDateShort(asset.updatedAt)}
                      </span>
                      <RatingControl
                        rating={stateDoc.assetRatings[asset.id] ?? 0}
                        onRate={(rating) => updateAssetRating(asset, rating)}
                      />
                      <span className="row-tags" onClick={(event) => event.stopPropagation()}>
                        {displayTags.map((tag) => (
                          <DropdownMenu key={tag}>
                            <DropdownMenuTrigger
                              className={cn(
                                'tag-pill',
                                removableTags.has(tag) && 'is-removable',
                              )}
                              type="button"
                              title={tag}
                            >
                              <span className="tag-text">{tag}</span>
                              {removableTags.has(tag) && (
                                <span
                                  className="tag-remove"
                                  title="Remove"
                                  onPointerDown={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                  }}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    removeAssetTag(asset, tag)
                                  }}
                                >
                                  <X />
                                </span>
                              )}
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" side="top">
                              <DropdownMenuItem
                                onSelect={() => {
                                  setSelectedTagFilters((current) =>
                                    toggleArrayValue(current, tag),
                                  )
                                }}
                              >
                                {selectedTagFilters.includes(tag)
                                  ? '取消 Tag 筛选'
                                  : '按此 Tag 筛选'}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ))}
                        <DropdownMenu
                          open={composerOpen}
                          onOpenChange={(open) => {
                            if (assets.length === 0) {
                              log('warn', '模板资源暂不支持修改标签。请先打开真实文件夹。')
                              return
                            }
                            if (open) {
                              setTagComposerAssetId(asset.id)
                              setTagComposerValue('')
                              return
                            }
                            if (tagComposerAssetId === asset.id) {
                              setTagComposerAssetId('')
                              setTagComposerValue('')
                            }
                          }}
                        >
                          <DropdownMenuTrigger
                            className="tag-pill tag-pill-add"
                            type="button"
                            title="Add tag"
                          >
                            <Plus />
                            <span className="tag-text">Tag</span>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" side="top">
                            <div
                              className="tag-compose"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Input
                                value={composerOpen ? tagComposerValue : ''}
                                placeholder="输入新 Tag"
                                autoFocus
                                onChange={(event) =>
                                  setTagComposerValue(event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setTagComposerAssetId('')
                                    setTagComposerValue('')
                                    return
                                  }
                                  if (event.key !== 'Enter') return
                                  event.preventDefault()
                                  addAssetTag(asset, tagComposerValue)
                                  setTagComposerAssetId('')
                                  setTagComposerValue('')
                                }}
                              />
                            </div>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </span>
                    <span className="row-actions asset-sticky asset-sticky-actions" onClick={(event) => event.stopPropagation()}>
                      <ToolbarIconButton
                        label="重命名"
                        onClick={() => renameAsset(asset)}
                        disabled={!asset.fileHandle}
                      >
                        <Pencil />
                      </ToolbarIconButton>
                      <ToolbarIconButton
                        label="下载"
                        onClick={() => downloadAsset(asset)}
                      >
                        <Download />
                      </ToolbarIconButton>
                      <ToolbarIconButton
                        label="删除"
                        danger
                        onClick={() => deleteAsset(asset)}
                        disabled={!asset.fileHandle}
                      >
                        <Trash2 />
                      </ToolbarIconButton>
                    </span>
                  </div>
                    )
                  })()
                ))}
                <div
                  className="asset-virtual-spacer"
                  style={{ height: virtualBottomHeight }}
                  aria-hidden="true"
                />
                <datalist id="asset-tag-options">
                  {tagOptions.map((tag) => (
                    <option key={tag} value={tag} />
                  ))}
                </datalist>
                {visibleAssets.length === 0 && (
                  <div className="empty-list">No assets</div>
                )}
              </div>
            </div>
            <AnimatePresence initial={false}>
              {focusedAsset && (
                <motion.div
                  className="asset-preview-card"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <PreviewPane
                    asset={focusedAsset}
                    history={stateDoc.history}
                    fileIndex={fileIndex}
                    onClose={() => setFocusedId('')}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {selectedIds.size > 0 && (
                <motion.div
                  className="selection-bar"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <span>{selectedIds.size} selected</span>
                  <Button
                    className="selection-clear"
                    type="button"
                    variant="ghost"
                    onClick={() => setSelectedIds(new Set())}
                    aria-label="Clear selection"
                  >
                    ×
                  </Button>
                  <span className="selection-divider" />
                  <Button type="button" variant="ghost" onClick={downloadSelectedAssets}>
                    <Download data-icon="inline-start" />
                    Download
                  </Button>
                  <Button type="button" variant="ghost" onClick={deleteSelectedAssets}>
                    <Trash2 data-icon="inline-start" />
                    Delete
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>

        <div className={cn('log-dock', activityCollapsed && 'is-collapsed')}>
          <div className="log-head">
            <Button
              className="log-toggle"
              type="button"
              variant="ghost"
              aria-label={activityCollapsed ? '展开 Activity' : '收起 Activity'}
              onClick={() => setActivityCollapsed((value) => !value)}
            >
              <span>Log</span>
              {activityCollapsed ? <ChevronUp /> : <ChevronDown />}
            </Button>
          </div>
          <AnimatePresence initial={false}>
          {!activityCollapsed && (
            <motion.div
              className="log-content"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <ScrollArea className="log-scroll">
              {activity.map((item) => (
                <div className={cn('log-line', item.level)} key={item.id}>
                  [{item.time}] {item.message}
                </div>
              ))}
              {activity.length === 0 && (
                <div className="log-line info">
                  请选择文件夹；打开后会报告是否找到根目录索引文件。
                </div>
              )}
              </ScrollArea>
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      </section>
    </motion.main>
    </TooltipProvider>
  )
}

function KindIconBadge({ asset }: { asset: AssetRecord }) {
  const Icon = KIND_ICON_COMPONENTS[asset.kind]

  return (
    <Badge
      className={cn('kind-dot', `is-${asset.kind}`)}
      variant="secondary"
      title={formatAssetKind(asset)}
      aria-label={formatAssetKind(asset)}
    >
      <Icon />
    </Badge>
  )
}

function FilterGroupControl({
  title,
  count,
  selectedLabels,
  expanded,
  onOpenChange,
  className,
  triggerClassName,
  children,
}: {
  title: string
  count: number
  selectedLabels?: string[]
  expanded: boolean
  onOpenChange: (open: boolean) => void
  className?: string
  triggerClassName?: string
  children: ReactNode
}) {
  const visibleLabels = (selectedLabels ?? []).slice(0, 2)
  const overflowCount = Math.max(count - visibleLabels.length, 0)

  return (
    <DropdownMenu open={expanded} onOpenChange={onOpenChange}>
      <section className={cn('filter-group', expanded && 'is-expanded', className)}>
        <DropdownMenuTrigger asChild>
          <Button
            className={cn(
              'filter-group-trigger',
              '!h-6 !justify-start !px-2 !text-[11px]',
              triggerClassName,
            )}
            variant="outline"
            size="xs"
            type="button"
          >
            <span className="filter-title">{title}</span>
            {visibleLabels.length > 0 && (
              <span className="filter-selected">
                {visibleLabels.map((label) => (
                  <Badge key={label} variant="secondary">
                    {label}
                  </Badge>
                ))}
                {overflowCount > 0 && (
                  <Badge variant="secondary">+{overflowCount}</Badge>
                )}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="filter-options" align="start">
          {children}
        </DropdownMenuContent>
      </section>
    </DropdownMenu>
  )
}

function FilterOptionButton({
  active,
  className,
  ...props
}: ComponentProps<typeof Button> & { active?: boolean }) {
  return (
    <Button
      className={cn('filter-option', active && 'is-active', className)}
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      type="button"
      {...props}
    />
  )
}

function RatingControl({
  rating,
  onRate,
}: {
  rating: number
  onRate: (rating: number) => void
}) {
  return (
    <span className="rating-control" onClick={(event) => event.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Button
          key={value}
          type="button"
          variant="ghost"
          size="icon-xs"
          className={rating >= value ? 'is-active' : ''}
          title={`${value} 分`}
          onClick={() => onRate(value)}
        >
          <Star />
        </Button>
      ))}
    </span>
  )
}

function ToolbarIconButton({
  label,
  active = false,
  danger = false,
  className,
  children,
  ...props
}: ComponentProps<typeof Button> & {
  label: string
  active?: boolean
  danger?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className={cn('icon-button', active && 'is-active', danger && 'danger', className)}
          variant={danger ? 'destructive' : active ? 'secondary' : 'ghost'}
          size="icon-sm"
          type="button"
          title={label}
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function formatAssetKind(asset: AssetRecord) {
  if (
    asset.kind === 'model' &&
    [...asset.tags, asset.typeLabel, ...Object.values(asset.metadata)]
      .join(' ')
      .toLocaleLowerCase()
      .includes('anim')
  ) {
    return 'Animation'
  }

  const labels: Record<AssetKind, string> = {
    image: 'Image',
    audio: 'Audio',
    video: 'Video',
    model: 'Model',
    document: 'Document',
    unknown: 'Unknown',
  }

  return labels[asset.kind]
}

function formatFileExtension(asset: AssetRecord) {
  const raw =
    asset.extension ||
    (asset.normalizedPath || asset.reference || '').split('.').pop() ||
    ''
  if (!raw) return '-'
  return `.${raw.toLocaleLowerCase()}`
}

function formatFileSize(size?: number) {
  if (!size) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

function formatDateShort(value?: number) {
  if (value == null) return '—'
  return new Date(value).toISOString().slice(0, 10)
}

function formatDateTime(value?: number) {
  if (value == null) return ''
  return new Date(value).toLocaleString()
}

function isUserAbort(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.message.includes('aborted'))
  )
}

function toggleArrayValue<T>(items: T[], value: T) {
  return items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value]
}

export default App
