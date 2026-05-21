import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { Box, Pause, Play, RotateCcw } from 'lucide-react'
import type { AssetRecord, IndexedFile } from '../types'
import { dirname, getExtension, joinPath, normalizeLookupPath } from '../lib/fileSystem'
import { loadVoxModel } from '../lib/voxModel'
import { Button } from './ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'

interface ModelViewerProps {
  asset: AssetRecord
  fileIndex: Map<string, IndexedFile>
  onStats?: (stats: { triangles: number }) => void
}

const SUPPORT_FILES = new Set([
  'bin',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'avif',
  'ktx2',
  'basis',
  'hdr',
])

export function ModelViewer({ asset, fileIndex, onStats }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onStatsRef = useRef(onStats)
  const [clips, setClips] = useState<string[]>([])
  const [activeClip, setActiveClip] = useState('')
  const [playing, setPlaying] = useState(true)
  const [message, setMessage] = useState('Preparing 3D viewport')
  const playingRef = useRef(true)
  const mixerRef = useRef<THREE.AnimationMixer | null>(null)
  const actionsRef = useRef<Map<string, THREE.AnimationAction>>(new Map())
  const currentActionRef = useRef<THREE.AnimationAction | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const framedViewRef = useRef<{
    position: THREE.Vector3
    target: THREE.Vector3
    near: number
    far: number
  } | null>(null)
  const modelKey = `${asset.id}:${asset.normalizedPath}`

  const localAsset = asset

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    onStatsRef.current = onStats
  }, [onStats])

  useEffect(() => {
    if (!activeClip || actionsRef.current.size === 0) return
    const nextAction = actionsRef.current.get(activeClip)
    if (!nextAction || currentActionRef.current === nextAction) return
    currentActionRef.current?.fadeOut(0.18)
    nextAction.reset().fadeIn(0.18).play()
    currentActionRef.current = nextAction
  }, [activeClip])

  useEffect(() => {
    let disposed = false
    const host = hostRef.current
    if (!host) return

    const cleanupUrls: string[] = []
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf7f8fa)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000)
    camera.position.set(3.5, 2.5, 4.5)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.innerHTML = ''
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0.75, 0)
    controlsRef.current = controls

    scene.add(new THREE.HemisphereLight(0xffffff, 0xcdd3ce, 2.4))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3)
    keyLight.position.set(5, 7, 4)
    scene.add(keyLight)

    const grid = new THREE.GridHelper(8, 16, 0xaeb5af, 0xd7dad5)
    grid.position.y = -0.01
    scene.add(grid)

    const clock = new THREE.Clock()
    let mixer: THREE.AnimationMixer | null = null
    let currentAction: THREE.AnimationAction | null = null
    let frame = 0

    const resize = () => {
      const bounds = host.getBoundingClientRect()
      const width = Math.max(1, bounds.width)
      const height = Math.max(1, bounds.height)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    const frameModel = (object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object)
      if (box.isEmpty()) return
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      object.position.sub(center)
      const maxAxis = Math.max(size.x, size.y, size.z, 0.001)
      const distance = maxAxis * 2.1
      camera.position.set(distance, distance * 0.65, distance)
      camera.near = Math.max(distance / 1000, 0.01)
      camera.far = distance * 100
      camera.updateProjectionMatrix()
      controls.target.set(0, 0, 0)
      controls.update()
      framedViewRef.current = {
        position: camera.position.clone(),
        target: controls.target.clone(),
        near: camera.near,
        far: camera.far,
      }
    }

    const animate = () => {
      if (disposed) return
      frame = requestAnimationFrame(animate)
      const delta = clock.getDelta()
      if (playingRef.current) mixer?.update(delta)
      controls.update()
      renderer.render(scene, camera)
    }

    const loadModel = async () => {
      try {
        setMessage('Loading model')
        const assetUrl = await getAssetUrl(localAsset)
        cleanupUrls.push(assetUrl)
        const resourceUrls = await collectRelativeResources(localAsset, fileIndex)
        cleanupUrls.push(...resourceUrls.values())

        const manager = new THREE.LoadingManager()
        manager.setURLModifier((url) => {
          const clean = url.split(/[?#]/)[0]
          if (/^(blob:|data:|https?:)/i.test(clean)) return url
          const resolved = normalizeLookupPath(
            joinPath(dirname(localAsset.normalizedPath), clean),
          )
          return resourceUrls.get(resolved) ?? url
        })

        const extension = getExtension(localAsset.normalizedPath)
        let object: THREE.Object3D
        let animations: THREE.AnimationClip[] = []

        if (extension === 'obj') {
          object = await new OBJLoader(manager).loadAsync(assetUrl)
        } else if (extension === 'stl') {
          const geometry = await new STLLoader(manager).loadAsync(assetUrl)
          geometry.computeVertexNormals()
          object = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              color: 0xd7d0bf,
              metalness: 0.12,
              roughness: 0.72,
            }),
          )
        } else if (extension === 'vox') {
          object = await loadVoxModel(assetUrl)
        } else {
          const result = await new GLTFLoader(manager).loadAsync(assetUrl)
          object = result.scene
          animations = result.animations
        }

        if (disposed) return
        scene.add(object)
        frameModel(object)
        if (onStatsRef.current) {
          let triangles = 0
          object.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return
            const geometry = child.geometry
            if (!geometry) return
            const index = geometry.getIndex()
            if (index) triangles += Math.floor(index.count / 3)
            else {
              const positions = geometry.getAttribute('position')
              if (positions) triangles += Math.floor(positions.count / 3)
            }
          })
          onStatsRef.current({ triangles })
        }
        const clipNames = animations.map(
          (clip) => clip.name || `Clip ${clip.uuid.slice(0, 4)}`,
        )
        setClips(clipNames)
        setActiveClip(clipNames[0] ?? '')
        if (animations.length) {
          mixer = new THREE.AnimationMixer(object)
          mixerRef.current = mixer
          actionsRef.current = new Map(
            animations.map((clip, index) => [
              clipNames[index],
              mixer!.clipAction(clip),
            ]),
          )
          currentAction =
            actionsRef.current.get(clipNames[0]) ?? mixer.clipAction(animations[0])
          currentActionRef.current = currentAction
          currentAction.play()
        }
        setMessage(animations.length ? 'Animation ready' : 'Model ready')
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '模型加载失败')
      }
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    animate()
    void loadModel()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      renderer.dispose()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material]
          materials.forEach((material) => material.dispose())
        }
      })
      cleanupUrls.forEach((url) => URL.revokeObjectURL(url))
      mixerRef.current = null
      actionsRef.current.clear()
      currentActionRef.current = null
      cameraRef.current = null
      controlsRef.current = null
      framedViewRef.current = null
      host.innerHTML = ''
    }
  }, [fileIndex, localAsset, modelKey])

  return (
    <div className="model-preview">
      <div ref={hostRef} className="model-canvas" />
      <div className="model-controls">
        <span className="model-status">
          <Box />
          {message}
        </span>
        {clips.length > 0 && (
          <Select
            value={activeClip}
            onValueChange={setActiveClip}
          >
            <SelectTrigger className="model-select" size="sm" aria-label="Animation clip">
              <SelectValue placeholder="Animation clip" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {clips.map((clip) => (
                  <SelectItem key={clip} value={clip}>
                    {clip}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {clips.length > 0 && (
          <Button
            className="icon-button"
            type="button"
            variant="ghost"
            size="icon-sm"
            title={playing ? '暂停动画' : '播放动画'}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
        )}
        <Button
          className="icon-button"
          type="button"
          variant="ghost"
          size="icon-sm"
          title="重置 3D 视窗"
          onClick={() => {
            const camera = cameraRef.current
            const controls = controlsRef.current
            const view = framedViewRef.current
            if (!camera || !controls || !view) return
            camera.position.copy(view.position)
            camera.near = view.near
            camera.far = view.far
            camera.updateProjectionMatrix()
            controls.target.copy(view.target)
            controls.update()
            setMessage('View reset')
          }}
        >
          <RotateCcw />
        </Button>
      </div>
    </div>
  )
}

async function getAssetUrl(asset: AssetRecord) {
  if (asset.previewUrl) return asset.previewUrl
  if (asset.isExternal) return asset.reference
  if (!asset.fileHandle) throw new Error('找不到本地模型文件。')
  return URL.createObjectURL(await asset.fileHandle.getFile())
}

async function collectRelativeResources(
  asset: AssetRecord,
  fileIndex: Map<string, IndexedFile>,
) {
  const baseDir = dirname(asset.normalizedPath)
  const urls = new Map<string, string>()
  if (!baseDir && asset.extension === 'glb') return urls

  for (const [path, indexed] of fileIndex.entries()) {
    if (baseDir && !path.startsWith(`${normalizeLookupPath(baseDir)}/`)) continue
    if (!SUPPORT_FILES.has(getExtension(indexed.path))) continue
    const file = await indexed.handle.getFile()
    urls.set(path, URL.createObjectURL(file))
  }

  return urls
}
