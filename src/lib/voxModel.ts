import * as THREE from 'three'

type VoxVoxel = {
  x: number
  y: number
  z: number
  colorIndex: number
}

type VoxModel = {
  size: THREE.Vector3
  voxels: VoxVoxel[]
}

type VoxRgba = [number, number, number, number]

const FACE_DEFINITIONS = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 0, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 1],
      [0, 0, 0],
      [0, 1, 0],
      [0, 1, 1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [0, 1, 1],
      [0, 1, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 0, 0],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [1, 0, 1],
      [0, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
] as const

const DEFAULT_COLOR = new THREE.Color(0xd7d0bf)

export async function loadVoxModel(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`VOX 加载失败：${response.statusText}`)
  return createVoxObject(await response.arrayBuffer())
}

export function createVoxObject(buffer: ArrayBuffer) {
  const { models, palette } = parseVox(buffer)
  if (models.length === 0) throw new Error('VOX 文件没有找到 SIZE / XYZI 模型数据。')

  const group = new THREE.Group()
  group.name = 'MagicaVoxel VOX'
  const offset = new THREE.Vector3()

  models.forEach((model, index) => {
    const geometry = buildVoxelGeometry(model, palette)
    geometry.translate(-model.size.x / 2, 0, -model.size.y / 2)
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.04,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `VOX Model ${index + 1}`
    mesh.position.copy(offset)
    offset.x += model.size.x + 4
    group.add(mesh)
  })

  return group
}

function parseVox(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  if (buffer.byteLength < 20 || readId(view, 0) !== 'VOX ') {
    throw new Error('不是有效的 MagicaVoxel VOX 文件。')
  }

  const version = view.getInt32(4, true)
  if (version <= 0) throw new Error('VOX 文件版本无效。')

  const models: VoxModel[] = []
  let pendingSize: THREE.Vector3 | null = null
  let palette: VoxRgba[] | undefined

  walkChunks(view, 8, buffer.byteLength, (id, contentStart, contentEnd) => {
    if (id === 'SIZE') {
      if (contentEnd - contentStart < 12) return
      pendingSize = new THREE.Vector3(
        view.getInt32(contentStart, true),
        view.getInt32(contentStart + 4, true),
        view.getInt32(contentStart + 8, true),
      )
      return
    }

    if (id === 'XYZI' && pendingSize) {
      if (contentEnd - contentStart < 4) return
      const count = view.getInt32(contentStart, true)
      const voxels: VoxVoxel[] = []
      let cursor = contentStart + 4
      const maxCursor = Math.min(contentEnd, cursor + count * 4)
      while (cursor + 3 < maxCursor) {
        voxels.push({
          x: view.getUint8(cursor),
          y: view.getUint8(cursor + 1),
          z: view.getUint8(cursor + 2),
          colorIndex: view.getUint8(cursor + 3),
        })
        cursor += 4
      }
      models.push({ size: pendingSize, voxels })
      pendingSize = null
      return
    }

    if (id === 'RGBA' && contentEnd - contentStart >= 1024) {
      palette = parsePalette(view, contentStart)
    }
  })

  return { models, palette }
}

function walkChunks(
  view: DataView,
  start: number,
  end: number,
  visit: (id: string, contentStart: number, contentEnd: number) => void,
) {
  let cursor = start
  while (cursor + 12 <= end) {
    const id = readId(view, cursor)
    const contentSize = view.getInt32(cursor + 4, true)
    const childrenSize = view.getInt32(cursor + 8, true)
    const contentStart = cursor + 12
    const contentEnd = contentStart + contentSize
    const childrenStart = contentEnd
    const childrenEnd = childrenStart + childrenSize
    if (contentSize < 0 || childrenSize < 0 || childrenEnd > end) return

    visit(id, contentStart, contentEnd)
    if (childrenSize > 0) walkChunks(view, childrenStart, childrenEnd, visit)
    cursor = childrenEnd
  }
}

function parsePalette(view: DataView, start: number) {
  const palette: VoxRgba[] = [[0, 0, 0, 0]]
  for (let index = 0; index < 256; index += 1) {
    const cursor = start + index * 4
    palette[index + 1] = [
      view.getUint8(cursor),
      view.getUint8(cursor + 1),
      view.getUint8(cursor + 2),
      view.getUint8(cursor + 3),
    ]
  }
  return palette
}

function buildVoxelGeometry(model: VoxModel, palette?: VoxRgba[]) {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const occupied = new Set(model.voxels.map((voxel) => voxelKey(voxel.x, voxel.y, voxel.z)))
  const color = new THREE.Color()

  model.voxels.forEach((voxel) => {
    const rgb = palette?.[voxel.colorIndex]
    if (rgb) color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace)
    else color.copy(DEFAULT_COLOR)

    for (const face of FACE_DEFINITIONS) {
      const [nx, ny, nz] = face.normal
      if (occupied.has(voxelKey(voxel.x + nx, voxel.y + ny, voxel.z + nz))) continue

      const baseIndex = positions.length / 3
      for (const [cx, cy, cz] of face.corners) {
        positions.push(voxel.x + cx, voxel.z + cz, voxel.y + cy)
        normals.push(nx, nz, ny)
        colors.push(color.r, color.g, color.b)
      }
      indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3)
    }
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function voxelKey(x: number, y: number, z: number) {
  return `${x}:${y}:${z}`
}

function readId(view: DataView, start: number) {
  return String.fromCharCode(
    view.getUint8(start),
    view.getUint8(start + 1),
    view.getUint8(start + 2),
    view.getUint8(start + 3),
  )
}
