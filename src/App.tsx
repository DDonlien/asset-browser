import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Box,
  ChevronDown,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  Download,
  Eye,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  Image as ImageIcon,
  Lock,
  MousePointerClick,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Type,
  Unlock,
} from 'lucide-react'
import './App.css'
import { InlineAudioPlayer } from './components/InlineAudioPlayer'
import { PreviewPane } from './components/PreviewPane'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Input } from './components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './components/ui/popover'
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
  findManifestFiles,
  getExtension,
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
import { getKindLabel, isExternalReference, parseManifest } from './lib/manifest'
import {
  addAssetsToCollections,
  addHistory,
  loadLocalState,
  normalizeState,
  recordRename,
  removeAssetsFromCollection,
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
type FilterGroup = 'type' | 'tag' | 'collection' | 'rating'

const EMPTY_INDEX: FileIndex = {
  byPath: new Map<string, IndexedFile>(),
  byBasename: new Map<string, IndexedFile[]>(),
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
  const [manifests, setManifests] = useState<ManifestSource[]>([])
  const [activeManifestId, setActiveManifestId] = useState('')
  const [fileIndex, setFileIndex] = useState<FileIndex>(EMPTY_INDEX)
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [focusedId, setFocusedId] = useState('')
  const [previewAssetId, setPreviewAssetId] = useState('')
  const [activeAudioId, setActiveAudioId] = useState('')
  const [audioPlaySignal, setAudioPlaySignal] = useState(0)
  const [previewMode, setPreviewMode] = useState<'click' | 'hover'>('click')
  const [previewLocked, setPreviewLocked] = useState(true)
  const [sourcePanelCollapsed, setSourcePanelCollapsed] = useState(false)
  const [activityCollapsed, setActivityCollapsed] = useState(false)
  const [expandedFilterGroups, setExpandedFilterGroups] = useState<FilterGroup[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [selectedKindFilters, setSelectedKindFilters] = useState<AssetKind[]>([])
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([])
  const [selectedCollectionFilters, setSelectedCollectionFilters] = useState<string[]>([])
  const [selectedRatingFilters, setSelectedRatingFilters] = useState<number[]>([])
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({})
  const [stateDoc, setStateDoc] = useState<AppStateDoc>(() => loadLocalState())
  const [metadataReady, setMetadataReady] = useState(false)
  const [busy, setBusy] = useState('')
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const lastMetadataSaveRef = useRef('')

  const activeManifest = manifests.find((item) => item.id === activeManifestId)
  const activeSourceName =
    activeManifestId === INDEX_SOURCE_ID
      ? INDEX_FILENAME
      : activeManifest?.name
  const templateAssets = useMemo(() => createTemplateAssets(), [])
  const sourceAssets = assets.length > 0 ? assets : templateAssets
  const previewAsset = sourceAssets.find((asset) => asset.id === previewAssetId)
  const tagOptions = useMemo(() => {
    const tags = new Set<string>()
    sourceAssets.forEach((asset) => {
      asset.tags.forEach((tag) => tags.add(tag))
      stateDoc.assetTags[asset.id]?.forEach((tag) => tags.add(tag))
    })
    return Array.from(tags).sort((a, b) => a.localeCompare(b))
  }, [sourceAssets, stateDoc.assetTags])

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
      if (terms.length === 0) return true
      const haystack = [
        asset.name,
        asset.reference,
        asset.normalizedPath,
        asset.folder,
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
    selectedTagFilters,
    selectedRatingFilters,
    query,
    stateDoc.assetRatings,
    stateDoc.assetTags,
  ])

  const previewableAsset =
    previewAsset && isPreviewPaneAsset(previewAsset) ? previewAsset : undefined
  const showPreviewPane = previewLocked || Boolean(previewableAsset)
  const workspaceClassName = cn(
    'workspace',
    showPreviewPane ? 'has-preview' : 'is-list-only',
  )
  const filteredAssetIds = useMemo(
    () => filteredAssets.map((asset) => asset.id),
    [filteredAssets],
  )
  const selectedFilteredCount = filteredAssetIds.filter((id) =>
    selectedIds.has(id),
  ).length
  const allFilteredSelected =
    filteredAssetIds.length > 0 &&
    selectedFilteredCount === filteredAssetIds.length

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
      setFileIndex(EMPTY_INDEX)
      setAssets([])
      setFocusedId('')
      setSelectedIds(new Set())
      setPreviewAssetId('')
      setActiveAudioId('')
      setActiveManifestId('')
      log('info', `已选择文件夹：${root.name}，正在检查根目录索引文件。`)
      setBusy('Indexing folder')
    } catch (error) {
      handlePickerError(error, '选择目录失败。')
      setBusy('')
      return
    }

    try {
      setMetadataReady(false)
      lastMetadataSaveRef.current = ''
      const [nextManifests, nextIndex] = await Promise.all([
        findManifestFiles(root),
        buildFileIndex(root),
      ])
      setManifests(nextManifests)
      setFileIndex(nextIndex)

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

  const reloadActiveManifest = async () => {
    if (!rootHandle) return
    try {
      setBusy('Reloading')
      const [nextManifests, nextIndex] = await Promise.all([
        findManifestFiles(rootHandle),
        buildFileIndex(rootHandle),
      ])
      setManifests(nextManifests)
      setFileIndex(nextIndex)
      if (activeManifestId === INDEX_SOURCE_ID || !activeManifestId) {
        await loadIndexForRoot(rootHandle, nextManifests, nextIndex, rootName)
        return
      }
      const syncResult = await syncIndexDocument(
        rootHandle,
        rootName,
        nextManifests,
        nextIndex,
      )
      logIndexResult(syncResult.status, syncResult.reason, syncResult.doc.assets.length)
      const manifest =
        nextManifests.find((item) => item.id === activeManifestId) ??
        nextManifests[0]
      if (!manifest) {
        setAssets([])
        setFocusedId('')
        return
      }
      setActiveManifestId(manifest.id)
      await loadManifest(manifest, nextIndex, rootName)
    } catch (error) {
      log('fail', error instanceof Error ? error.message : '重新读取失败。')
    } finally {
      setBusy('')
    }
  }

  const loadManifest = async (
    manifest: ManifestSource,
    index: FileIndex,
    sourceRootName = rootName,
  ) => {
    setBusy(`Reading ${manifest.name}`)
    const parsed = await parseManifest(manifest, index)
    const hydrated = await Promise.all(parsed.map(hydrateAsset))
    setAssets(hydrated)
    setFocusedId(hydrated[0]?.id ?? '')
    setPreviewAssetId('')
    setActiveAudioId('')
    setStateDoc((current) =>
      touchState({
        ...current,
        sourceRootName,
        activeManifestName: manifest.name,
      }),
    )
    log('success', `读取清单：${manifest.name}，${hydrated.length} 个资产。`)
    setBusy('')
  }

  const loadIndexForRoot = async (
    root: FileSystemDirectoryHandle,
    nextManifests: ManifestSource[],
    index: FileIndex,
    sourceRootName: string,
    options: { persistIndex?: boolean } = {},
  ) => {
    setBusy(`Checking ${INDEX_FILENAME}`)
    const result = await syncIndexDocument(root, sourceRootName, nextManifests, index, {
      persist: options.persistIndex ?? true,
    })
    const hydrated = await Promise.all(
      hydrateIndexAssets(result.doc, index).map(hydrateAsset),
    )
    setAssets(hydrated)
    setFocusedId(hydrated[0]?.id ?? '')
    setPreviewAssetId('')
    setActiveAudioId('')
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
        updatedAt: file.lastModified,
      }
    } catch {
      return { ...asset, status: 'missing' }
    }
  }

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
        filteredAssetIds.forEach((id) => next.delete(id))
      } else {
        filteredAssetIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const requestAudioPlayback = (assetId: string) => {
    setPreviewAssetId('')
    setActiveAudioId(assetId)
    setAudioPlaySignal((value) => value + 1)
  }

  const activateAsset = (asset: AssetRecord) => {
    focusAsset(asset)
    if (asset.kind === 'audio') {
      requestAudioPlayback(asset.id)
      return
    }
    setActiveAudioId('')
    if (previewMode === 'click') {
      setPreviewAssetId(isPreviewPaneAsset(asset) ? asset.id : '')
    }
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
      setPreviewAssetId((current) => (current === asset.id ? '' : current))
      setActiveAudioId((current) => (current === asset.id ? '' : current))
      log('success', `删除完成：${asset.name}`)
    } catch (error) {
      log('fail', error instanceof Error ? error.message : '删除失败。')
    } finally {
      setBusy('')
    }
  }

  const renameAsset = async (asset: AssetRecord) => {
    if (!rootHandle || asset.metadata.source === 'template') return
    if (!asset || !asset.fileHandle) return
    const currentName = asset.normalizedPath.split('/').pop() || asset.name
    const nextName = window.prompt('新的文件名', currentName)
    if (!nextName || nextName === currentName) return
    try {
      setBusy('Renaming')
      const nextPath = await renameFileAtPath(rootHandle, asset.normalizedPath, nextName)
      const nextIndex = await buildFileIndex(rootHandle)
      setFileIndex(nextIndex)
      const indexed = nextIndex.byPath.get(nextPath.toLocaleLowerCase())
      setAssets((items) =>
        items.map((item) =>
          item.id === asset.id
            ? {
                ...item,
                name: stripExtension(nextName),
                reference: nextPath,
                normalizedPath: nextPath,
                folder: nextPath.includes('/')
                  ? nextPath.split('/').slice(0, -1).join('/')
                  : 'root',
                extension: getExtension(nextPath),
                fileHandle: indexed?.handle,
              }
            : item,
        ),
      )
      setStateDoc((current) => recordRename(current, asset, nextPath))
      log('success', `重命名：${currentName} -> ${nextName}`)
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

  const isAssetInCollection = (assetId: string, collectionId: string) => {
    return Boolean(
      stateDoc.favorites
        .find((collection) => collection.id === collectionId)
        ?.entries.some((entry) => entry.id === assetId),
    )
  }

  const toggleFavoriteCollection = (asset: AssetRecord, collectionId: string) => {
    const collection = stateDoc.favorites.find((item) => item.id === collectionId)
    if (!collection) return
    if (isAssetInCollection(asset.id, collection.id)) {
      setStateDoc((current) =>
        removeAssetsFromCollection(current, [asset.id], collection.id),
      )
      log('success', `已从 ${collection.name} 移除：${asset.name}`)
      return
    }
    setStateDoc((current) =>
      addAssetsToCollections(current, [asset], [collection.id]),
    )
    log('success', `收藏到 ${collection.name}：${asset.name}`)
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

  const addAssetTag = (asset: AssetRecord, value: string) => {
    const nextTag = value.trim()
    if (!nextTag) return
    const currentTags = stateDoc.assetTags[asset.id] ?? []
    if ([...asset.tags, ...currentTags].includes(nextTag)) {
      setTagDrafts((current) => ({ ...current, [asset.id]: '' }))
      return
    }
    const nextTags = [...currentTags, nextTag]
    setStateDoc((current) => setAssetTags(current, asset, nextTags))
    setTagDrafts((current) => ({ ...current, [asset.id]: '' }))
    log('success', `新增标签：${asset.name} -> ${nextTag}`)
  }

  const removeAssetTag = (asset: AssetRecord, tag: string) => {
    const currentTags = stateDoc.assetTags[asset.id] ?? []
    if (!currentTags.includes(tag)) return
    const nextTags = currentTags.filter((item) => item !== tag)
    setStateDoc((current) => setAssetTags(current, asset, nextTags))
    log('success', `移除标签：${asset.name} -> ${tag}`)
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
          <span className="nav-monogram">AB</span>
          <span>Panel</span>
          <span className="nav-toggle-mark" aria-hidden="true">
            {sourcePanelCollapsed ? (
              <ChevronsRight />
            ) : (
              <ChevronsLeft />
            )}
          </span>
        </Button>
        <Button className="nav-item is-active" variant="ghost" type="button" title="Assets">
          <ImageIcon />
          <span>Assets</span>
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
          <div>
            <h1>Asset Browser</h1>
            <p>Art + implementation library</p>
          </div>
          <div className="brand-actions">
            <ToolbarIconButton
              label="收起资源面板"
              onClick={() => setSourcePanelCollapsed(true)}
            >
              <ChevronsLeft />
            </ToolbarIconButton>
            <ToolbarIconButton
              label={previewMode === 'click' ? '点击预览' : 'Hover 预览'}
              active={previewMode === 'hover'}
              onClick={() =>
                setPreviewMode((mode) => (mode === 'click' ? 'hover' : 'click'))
              }
            >
              {previewMode === 'click' ? (
                <MousePointerClick />
              ) : (
                <Eye />
              )}
            </ToolbarIconButton>
            <ToolbarIconButton
              label={previewLocked ? '预览窗格已锁定' : '锁定预览窗格'}
              active={previewLocked}
              onClick={() => setPreviewLocked((value) => !value)}
            >
              {previewLocked ? <Lock /> : <Unlock />}
            </ToolbarIconButton>
            <ToolbarIconButton
              label="重新读取"
              onClick={reloadActiveManifest}
              disabled={!rootHandle || Boolean(busy)}
            >
              <RefreshCw />
            </ToolbarIconButton>
          </div>
        </div>

        <ScrollArea className="panel-body">
          <section className="drop">
            <strong>{rootName || 'No folder selected'}</strong>
            <span>{activeSourceName || 'CSV / XLSX manifest'}</span>
            <div className="folder-actions">
              <Button
                className="primary"
                type="button"
                onClick={chooseRoot}
                disabled={!supportsFileSystemAccess()}
              >
                <FolderOpen data-icon="inline-start" />
                OPEN FOLDER
              </Button>
              {rootHandle && assets.length === 0 && (
                <Button type="button" variant="outline" onClick={loadMetadataManually}>
                  META
                </Button>
              )}
            </div>
            {!supportsFileSystemAccess() && (
              <span className="warn-text">Chrome / Edge required</span>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Production</h2>
              {busy && <Badge className="busy-chip" variant="secondary">{busy}</Badge>}
            </div>
            <div className="stats-grid">
              <div>
                <span>Assets</span>
                <strong>{sourceAssets.length}</strong>
              </div>
              <div>
                <span>Visible</span>
                <strong>{filteredAssets.length}</strong>
              </div>
              <div>
                <span>Selected</span>
                <strong>{selectedIds.size}</strong>
              </div>
              <div>
                <span>Missing</span>
                <strong>{sourceAssets.filter((a) => a.status === 'missing').length}</strong>
              </div>
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Collections</h2>
            </div>
            <div className="favorite-list">
              {stateDoc.favorites.map((collection) => (
                <Button
                  key={collection.id}
                  className={cn(
                    'collection-row',
                    selectedCollectionFilters.includes(collection.id) && 'is-active',
                  )}
                  variant="ghost"
                  type="button"
                  onClick={() =>
                    setSelectedCollectionFilters((current) =>
                      toggleArrayValue(current, collection.id),
                    )
                  }
                >
                  <Star />
                  <span>{collection.name}</span>
                  <strong>{collection.entries.length}</strong>
                </Button>
              ))}
            </div>
          </section>
        </ScrollArea>
      </motion.aside>
      )}
      </AnimatePresence>

      <section className="viewport">
        <header className="topbar">
          <div className="topbar-filters">
            <div className="topbar-search">
              <Search />
              <Input
                value={query}
                placeholder="Search name / type / path"
                aria-label="Search assets"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="topbar-filter-row">
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
            </div>
          </div>
        </header>

        <div className={workspaceClassName}>
          <section className="asset-list" aria-label="Assets">
            <div className="asset-list-head">
              <span className="asset-select-head">
                <Checkbox
                  className="select-checkbox"
                  checked={
                    allFilteredSelected
                      ? true
                      : selectedFilteredCount > 0
                        ? 'indeterminate'
                        : false
                  }
                  disabled={filteredAssetIds.length === 0}
                  aria-label="Select all visible assets"
                  onCheckedChange={toggleFilteredSelection}
                />
              </span>
              <span className="asset-name-head">Name</span>
              <span className="asset-middle-head">
                <span>Type</span>
                <span>Rating</span>
                <span>Path</span>
                <span>Status</span>
              </span>
              <span className="asset-tag-head">Tag</span>
              <span className="asset-actions-head">Actions</span>
            </div>
            <ScrollArea className="asset-rows">
              <AnimatePresence initial={false}>
              {filteredAssets.map((asset) => (
                (() => {
                  const displayTags = Array.from(new Set([
                    ...asset.tags,
                    ...(stateDoc.assetTags[asset.id] ?? []),
                  ]))
                  const visibleTagLimit = displayTags.length > 2 ? 2 : 3
                  const visibleTags = displayTags.slice(0, visibleTagLimit)
                  const hiddenTagCount = Math.max(displayTags.length - visibleTags.length, 0)
                  const primaryCollection = stateDoc.favorites[0]
                  return (
                <motion.div
                  key={asset.id}
                  layout
                  role="button"
                  tabIndex={0}
                  className={cn('asset-row', asset.id === focusedId && 'is-focused')}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                  onClick={() => {
                    activateAsset(asset)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      activateAsset(asset)
                    }
                  }}
                  onMouseEnter={() => {
                    if (previewMode !== 'hover') return
                    if (asset.kind === 'audio') {
                      requestAudioPlayback(asset.id)
                      return
                    }
                    setActiveAudioId('')
                    if (!previewLocked && isPreviewPaneAsset(asset)) {
                      setPreviewAssetId(asset.id)
                    }
                  }}
                  onMouseLeave={() => {
                    if (previewMode !== 'hover') return
                    if (asset.kind === 'audio') setActiveAudioId('')
                    if (!previewLocked) setPreviewAssetId('')
                  }}
                >
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
                  <span className="asset-name">
                    <strong>{asset.name}</strong>
                    {asset.kind === 'audio' ? (
                      <InlineAudioPlayer
                        asset={asset}
                        active={activeAudioId === asset.id}
                        playSignal={activeAudioId === asset.id ? audioPlaySignal : 0}
                        previewMode={previewMode}
                        onActivate={() => requestAudioPlayback(asset.id)}
                        onInteract={() => setPreviewAssetId('')}
                      />
                    ) : null}
                  </span>
                  <span className="asset-middle">
                    <KindIconBadge kind={asset.kind} />
                    <RatingControl
                      rating={stateDoc.assetRatings[asset.id] ?? 0}
                      onRate={(rating) => updateAssetRating(asset, rating)}
                    />
                    <span className="asset-path">{asset.normalizedPath || asset.reference}</span>
                    <Badge className={cn('status-pill', `is-${asset.status}`)} variant="outline">
                      {asset.status}
                    </Badge>
                  </span>
                  <span className="row-tags" onClick={(event) => event.stopPropagation()}>
                    {visibleTags.map((tag) => {
                      const removable = stateDoc.assetTags[asset.id]?.includes(tag)
                      return (
                        <button
                          key={tag}
                          className={cn('tag-pill', removable && 'is-removable')}
                          type="button"
                          title={removable ? `移除 ${tag}` : tag}
                          onClick={() => removable && removeAssetTag(asset, tag)}
                        >
                          {tag}
                        </button>
                      )
                    })}
                    {hiddenTagCount > 0 && (
                      <span className="tag-pill is-overflow">+{hiddenTagCount}</span>
                    )}
                    <label className="tag-add-pill">
                      <Plus />
                      <input
                        value={tagDrafts[asset.id] ?? ''}
                        list="asset-tag-options"
                        placeholder="Tag"
                        aria-label={`Add tag to ${asset.name}`}
                        onChange={(event) =>
                          setTagDrafts((current) => ({
                            ...current,
                            [asset.id]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          addAssetTag(asset, event.currentTarget.value)
                        }}
                        onBlur={(event) => addAssetTag(asset, event.currentTarget.value)}
                      />
                    </label>
                  </span>
                  <span className="row-actions" onClick={(event) => event.stopPropagation()}>
                    <ToolbarIconButton
                      label="重命名"
                      onClick={() => renameAsset(asset)}
                      disabled={!asset.fileHandle}
                    >
                      <Type />
                    </ToolbarIconButton>
                    <ToolbarIconButton
                      label="下载"
                      onClick={() => downloadAsset(asset)}
                    >
                      <Download />
                    </ToolbarIconButton>
                    {primaryCollection && (
                      <ToolbarIconButton
                        label={`收藏到${primaryCollection.name}`}
                        active={isAssetInCollection(asset.id, primaryCollection.id)}
                        className="favorite-action"
                        onClick={() => toggleFavoriteCollection(asset, primaryCollection.id)}
                      >
                        <Star />
                      </ToolbarIconButton>
                    )}
                    <ToolbarIconButton
                      label="删除"
                      danger
                      onClick={() => deleteAsset(asset)}
                      disabled={!asset.fileHandle}
                    >
                      <Trash2 />
                    </ToolbarIconButton>
                  </span>
                </motion.div>
                  )
                })()
              ))}
              </AnimatePresence>
              <datalist id="asset-tag-options">
                {tagOptions.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              {filteredAssets.length === 0 && (
                <div className="empty-list">No assets</div>
              )}
            </ScrollArea>
          </section>

          <AnimatePresence initial={false}>
            {showPreviewPane && (
              <PreviewPane
                asset={previewableAsset}
                history={stateDoc.history}
                fileIndex={fileIndex.byPath}
              />
            )}
          </AnimatePresence>
        </div>

        <motion.div
          className={cn('log-dock', activityCollapsed && 'is-collapsed')}
          layout
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
          <div className="log-head">
            <span>Activity</span>
            <ToolbarIconButton
              label={activityCollapsed ? '展开 Activity' : '收起 Activity'}
              aria-label={activityCollapsed ? '展开 Activity' : '收起 Activity'}
              onClick={() => setActivityCollapsed((value) => !value)}
            >
              {activityCollapsed ? <ChevronUp /> : <ChevronDown />}
            </ToolbarIconButton>
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
        </motion.div>
      </section>
    </motion.main>
    </TooltipProvider>
  )
}

function KindIconBadge({ kind }: { kind: AssetKind }) {
  const Icon = KIND_ICON_COMPONENTS[kind]

  return (
    <Badge
      className={cn('kind-dot', `is-${kind}`)}
      variant="secondary"
      title={getKindLabel(kind)}
      aria-label={getKindLabel(kind)}
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
  children,
}: {
  title: string
  count: number
  selectedLabels?: string[]
  expanded: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const visibleLabels = (selectedLabels ?? []).slice(0, 2)
  const overflowCount = Math.max(count - visibleLabels.length, 0)

  return (
    <Popover open={expanded} onOpenChange={onOpenChange}>
      <section className={cn('filter-group', expanded && 'is-expanded')}>
        <PopoverTrigger asChild>
          <Button className="filter-group-trigger" variant="outline" type="button">
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
            {expanded ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="filter-options" align="start">
          {children}
        </PopoverContent>
      </section>
    </Popover>
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

function stripExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, '')
}

function isPreviewPaneAsset(asset: AssetRecord) {
  return asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'model'
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
