import { useEffect, useState } from 'react'
import {
  Clock3,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Music2,
  X,
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { AssetRecord, HistoryEntry, IndexedFile } from '../types'
import { getKindLabel } from '../lib/manifest'
import { ModelViewer } from './ModelViewer'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'

interface PreviewPaneProps {
  asset?: AssetRecord
  history: HistoryEntry[]
  fileIndex: Map<string, IndexedFile>
  onClose?: () => void
}

export function PreviewPane({ asset, history, fileIndex, onClose }: PreviewPaneProps) {
  const [preview, setPreview] = useState({ url: '', error: '' })
  const [resolution, setResolution] = useState({ assetId: '', value: '-' })
  const [duration, setDuration] = useState({ assetId: '', value: '-' })
  const [bitrate, setBitrate] = useState({ assetId: '', value: '-' })
  const [sampleRate, setSampleRate] = useState({ assetId: '', value: '-' })
  const [frameRate, setFrameRate] = useState({ assetId: '', value: '-' })
  const [modelTriangles, setModelTriangles] = useState({ assetId: '', value: '-' })
  const { url, error } = preview
  const activeResolution = resolution.assetId === asset?.id ? resolution.value : '-'
  const activeDuration = duration.assetId === asset?.id ? duration.value : '-'
  const activeBitrate = bitrate.assetId === asset?.id ? bitrate.value : '-'
  const activeSampleRate = sampleRate.assetId === asset?.id ? sampleRate.value : '-'
  const activeFrameRate = frameRate.assetId === asset?.id ? frameRate.value : '-'
  const activeTriangles = modelTriangles.assetId === asset?.id ? modelTriangles.value : '-'

  useEffect(() => {
    let revoked = ''
    let cancelled = false

    async function resolveUrl() {
      if (!asset) return { url: '', error: '' }
      if (asset.previewUrl) {
        return { url: asset.previewUrl, error: '' }
      }
      if (asset.isExternal) {
        return { url: asset.reference, error: '' }
      }
      if (!asset.fileHandle) {
        return { url: '', error: '本地文件没有解析到，请检查清单里的地址引用。' }
      }
      const file = await asset.fileHandle.getFile()
      revoked = URL.createObjectURL(file)
      return { url: revoked, error: '' }
    }

    void resolveUrl()
      .then((next) => {
        if (!cancelled) setPreview(next)
      })
      .catch((reason) => {
        if (!cancelled) {
          setPreview({
            url: '',
            error: reason instanceof Error ? reason.message : '预览加载失败。',
          })
        }
      })

    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [asset])

  useEffect(() => {
    if (!asset || asset.kind !== 'audio') return
    const currentAsset = asset
    let cancelled = false

    async function inspectAudio() {
      const AudioContextCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextCtor) return

      let buffer: ArrayBuffer | null = null
      if (currentAsset.fileHandle) {
        buffer = await (await currentAsset.fileHandle.getFile()).arrayBuffer()
      } else if (url && url.startsWith('blob:')) {
        buffer = await (await fetch(url)).arrayBuffer()
      }
      if (!buffer) return

      const context = new AudioContextCtor()
      try {
        const decoded = await context.decodeAudioData(buffer.slice(0))
        if (cancelled) return
        setSampleRate({
          assetId: currentAsset.id,
          value: `${Math.round(decoded.sampleRate)} Hz`,
        })
        if (decoded.duration > 0) {
          setDuration({ assetId: currentAsset.id, value: formatDuration(decoded.duration) })
          if (currentAsset.size) {
            setBitrate({
              assetId: currentAsset.id,
              value: formatBitrate(currentAsset.size, decoded.duration),
            })
          }
        }
      } finally {
        void context.close().catch(() => {})
      }
    }

    void inspectAudio().catch(() => {})

    return () => {
      cancelled = true
    }
  }, [asset, url])

  if (!asset) {
    return (
      <motion.section
        className="preview-empty"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
      >
        <div className="empty-mark">
          <ImageIcon />
        </div>
        <h2>SELECT AN ASSET</h2>
        <p>读取 CSV 或 Excel 后，选择左侧列表中的资源即可预览。</p>
        <RecentHistory history={history} />
      </motion.section>
    )
  }

  const details: Array<{ label: string; value: string }> = [
    { label: 'Name', value: asset.name },
    { label: 'File path', value: asset.normalizedPath || asset.reference },
  ]

  if (asset.kind === 'image') {
    details.push({ label: 'Resolution', value: activeResolution })
  }

  if (asset.kind === 'audio') {
    details.push({ label: 'Duration', value: activeDuration })
    details.push({ label: 'Bitrate', value: activeBitrate })
    details.push({ label: 'Sample rate', value: activeSampleRate })
  }

  if (asset.kind === 'video') {
    details.push({ label: 'Resolution', value: activeResolution })
    details.push({ label: 'Duration', value: activeDuration })
    details.push({ label: 'Bitrate', value: activeBitrate })
    details.push({ label: 'Frame rate', value: activeFrameRate })
  }

  if (asset.kind === 'model') {
    details.push({ label: 'Triangles', value: activeTriangles })
  }

  details.push({
    label: 'Format',
    value: asset.extension || asset.typeLabel || '-',
  })

  return (
    <motion.section
      className="preview-pane"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      <header className="preview-head">
        <div>
          <Badge className="eyebrow" variant="secondary">{getKindLabel(asset.kind)}</Badge>
          <h2>{asset.name}</h2>
        </div>
        <div className="flex items-center gap-2">
          {asset.isExternal && (
            <Button asChild variant="outline" size="sm">
            <a href={asset.reference} target="_blank" rel="noreferrer">
              <ExternalLink data-icon="inline-start" />
              OPEN
            </a>
            </Button>
          )}
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close preview"
              onClick={onClose}
            >
              <X />
            </Button>
          )}
        </div>
      </header>

      <div className={`preview-stage is-${asset.kind}`}>
        {error && <div className="preview-error">{error}</div>}
        {!error && asset.kind === 'image' && url && (
          <img
            src={url}
            alt={asset.name}
            onLoad={(event) => {
              const image = event.currentTarget
              setResolution({
                assetId: asset.id,
                value: `${image.naturalWidth} x ${image.naturalHeight}`,
              })
            }}
          />
        )}
        {!error && asset.kind === 'audio' && url && (
          <div className="audio-preview">
            <Music2 />
            <audio
              src={url}
              controls
              autoPlay
              onLoadedMetadata={(event) => {
                const element = event.currentTarget
                const durationValue = Number.isFinite(element.duration)
                  ? formatDuration(element.duration)
                  : '-'
                setDuration({ assetId: asset.id, value: durationValue })
                if (asset.size && element.duration > 0) {
                  setBitrate({
                    assetId: asset.id,
                    value: formatBitrate(asset.size, element.duration),
                  })
                }
              }}
            />
          </div>
        )}
        {!error && asset.kind === 'video' && url && (
          <video
            src={url}
            autoPlay
            controls
            playsInline
            onLoadedMetadata={(event) => {
              const video = event.currentTarget
              setResolution({
                assetId: asset.id,
                value: `${video.videoWidth} x ${video.videoHeight}`,
              })
              const durationValue = Number.isFinite(video.duration)
                ? formatDuration(video.duration)
                : '-'
              setDuration({ assetId: asset.id, value: durationValue })
              if (asset.size && video.duration > 0) {
                setBitrate({
                  assetId: asset.id,
                  value: formatBitrate(asset.size, video.duration),
                })
              }
              void measureFrameRate(video)
                .then((fps) => {
                  if (!fps) return
                  setFrameRate({ assetId: asset.id, value: `${fps.toFixed(1)} fps` })
                })
                .catch(() => {})
            }}
          />
        )}
        {!error && asset.kind === 'model' && (
          <ModelViewer
            asset={asset}
            fileIndex={fileIndex}
            onStats={(stats) => {
              setModelTriangles({
                assetId: asset.id,
                value: formatCount(stats.triangles),
              })
            }}
          />
        )}
        {!error && asset.kind === 'document' && url && (
          <iframe src={url} title={asset.name} />
        )}
        {!error && asset.kind === 'unknown' && (
          <div className="preview-error">该类型暂未识别，可通过下载或重命名继续管理。</div>
        )}
      </div>

      <div className="detail-list">
        {details.map((detail) => (
          <Detail key={detail.label} label={detail.label} value={detail.value} />
        ))}
      </div>
    </motion.section>
  )
}

function RecentHistory({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return null
  return (
    <ScrollArea className="recent-box">
      <h3>
        <Clock3 />
        RECENT
      </h3>
      {history.slice(0, 6).map((item) => (
        <div className="recent-row" key={`${item.id}-${item.openedAt}`}>
          <FileText />
          <span>{item.name}</span>
        </div>
      ))}
    </ScrollArea>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function formatBitrate(bytes: number, seconds: number) {
  if (!bytes || !seconds) return '-'
  const kbps = (bytes * 8) / 1000 / seconds
  if (!Number.isFinite(kbps) || kbps <= 0) return '-'
  return `${Math.round(kbps)} kbps`
}

function formatCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '-'
  return value.toLocaleString()
}

async function measureFrameRate(video: HTMLVideoElement) {
  const anyVideo = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (
      callback: (now: number, metadata: { presentedFrames: number }) => void,
    ) => number
  }
  if (!anyVideo.requestVideoFrameCallback) return null

  return await new Promise<number | null>((resolve) => {
    let firstNow = 0
    let firstFrames = 0
    const cancel = window.setTimeout(() => resolve(null), 900)
    anyVideo.requestVideoFrameCallback!((now1, meta1) => {
      firstNow = now1
      firstFrames = meta1.presentedFrames
      anyVideo.requestVideoFrameCallback!((now2, meta2) => {
        window.clearTimeout(cancel)
        const dt = (now2 - firstNow) / 1000
        const df = meta2.presentedFrames - firstFrames
        if (!dt || df <= 0) resolve(null)
        else resolve(df / dt)
      })
    })
  })
}
