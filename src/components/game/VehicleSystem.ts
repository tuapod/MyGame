import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export interface VehiclePlacement {
  x: number
  z: number
  rotY?: number
  scale?: number
}

export interface VehicleSystemOptions {
  scene: THREE.Scene
  url: string
  sampleHeight: (x: number, z: number) => number
  placements?: VehiclePlacement[]
  scatterRadius?: number
  useOriginalScale?: boolean
  targetSize?: number
  scaleMultiplier?: number
  receiveShadow?: boolean
  castShadow?: boolean
  alignToGround?: boolean
  tiltSmoothing?: number
  gravity?: number
  yOffset?: number
  footprintRatio?: number
  onLoaded?: (names: string[]) => void
  onError?: (err: unknown) => void
}

interface SpawnedVehicle {
  name: string
  root: THREE.Group
  yawPivot: THREE.Group
  tiltPivot: THREE.Group
  bbox: THREE.Box3
  halfX: number
  halfZ: number
  velocityY: number
  targetY: number
  targetTiltX: number
  targetTiltZ: number
  initialized: boolean
}

const MAX_SLOPE_TAN = Math.tan((45 * Math.PI) / 180) // حداکثر شیب ≈ ۴۵ درجه

/**
 * محاسبه‌ی bbox دقیق — مخصوصاً برای SkinnedMesh ها.
 * برای skinned: موقعیت واقعی vertexها بعد از boneTransform رو می‌گیره.
 * برای معمولی: از boundingBox هندسه استفاده می‌کنه.
 */
function computeAccurateBBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3()
  const tmp = new THREE.Vector3()
  root.updateMatrixWorld(true)

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh.visible === false) return

    const geo = mesh.geometry as THREE.BufferGeometry
    if (!geo || !geo.attributes || !geo.attributes.position) return

    const skinned = mesh as unknown as THREE.SkinnedMesh
    const isSkinned =
      (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true

    if (isSkinned && typeof skinned.boneTransform === 'function') {
      // برای skinned mesh، vertexها رو با bone transform حساب کن
      const posAttr = geo.attributes.position as THREE.BufferAttribute
      const total = posAttr.count
      // برای عملکرد بهتر، نمونه‌گیری
      const step = Math.max(1, Math.floor(total / 300))
      for (let i = 0; i < total; i += step) {
        tmp.fromBufferAttribute(posAttr, i)
        skinned.boneTransform(i, tmp)
        tmp.applyMatrix4(mesh.matrixWorld)
        box.expandByPoint(tmp)
      }
    } else {
      // برای mesh معمولی
      if (!geo.boundingBox) geo.computeBoundingBox()
      if (geo.boundingBox) {
        const localBox = geo.boundingBox.clone().applyMatrix4(mesh.matrixWorld)
        box.union(localBox)
      }
    }
  })

  return box
}

export class VehicleSystem {
  private scene: THREE.Scene
  private sampleHeight: (x: number, z: number) => number
  private vehicles: SpawnedVehicle[] = []
  private disposed = false
  private alignToGround: boolean
  private tiltSmoothing: number
  private gravity: number
  private yOffset: number
  private footprintRatio: number

  constructor(options: VehicleSystemOptions) {
    this.scene = options.scene
    this.sampleHeight = options.sampleHeight
    this.alignToGround = options.alignToGround ?? true
    this.tiltSmoothing = options.tiltSmoothing ?? 8
    this.gravity = options.gravity ?? 25
    this.yOffset = options.yOffset ?? 0
    this.footprintRatio = options.footprintRatio ?? 0.55

    const loader = new GLTFLoader()
    loader.load(
      options.url,
      (gltf) => {
        if (this.disposed) return
        try {
          this.spawnFromGltf(gltf.scene, options)
        } catch (err) {
          console.error('[VehicleSystem] Spawn failed:', err)
          options.onError?.(err)
        }
      },
      undefined,
      (err) => {
        console.error('[VehicleSystem] Failed to load:', options.url, err)
        options.onError?.(err)
      }
    )
  }

  getNames(): string[] {
    return this.vehicles.map((v) => v.name)
  }

  getCount(): number {
    return this.vehicles.length
  }

  getVehicles(): ReadonlyArray<SpawnedVehicle> {
    return this.vehicles
  }

  update(dt: number) {
    if (!this.alignToGround) return
    for (const v of this.vehicles) {
      this.updateVehiclePhysics(v, dt)
    }
  }

  dispose() {
    this.disposed = true
    for (const v of this.vehicles) {
      this.scene.remove(v.root)
      v.root.traverse((obj) => {
        const m = obj as THREE.Mesh
        if (m.isMesh) {
          m.geometry?.dispose()
          const mat = m.material
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
          else mat?.dispose()
        }
      })
    }
    this.vehicles.length = 0
  }

  // ---------------------------------------------------------------
  // Physics
  // ---------------------------------------------------------------

  private updateVehiclePhysics(v: SpawnedVehicle, dt: number) {
    const pos = v.root.position
    const yaw = v.yawPivot.rotation.y

    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    const xAxisX = cos, xAxisZ = -sin
    const zAxisX = sin, zAxisZ = cos

    // ⚠️ حداقل اندازه برای footprint، جلوگیری از تقسیم بر صفر
    const hx = Math.max(v.halfX, 0.5)
    const hz = Math.max(v.halfZ, 0.5)

    const sampleCorner = (lx: number, lz: number) => {
      const wx = pos.x + lx * xAxisX + lz * zAxisX
      const wz = pos.z + lx * xAxisZ + lz * zAxisZ
      return this.sampleHeight(wx, wz)
    }

    const hPP = sampleCorner(hx, hz)
    const hPN = sampleCorner(hx, -hz)
    const hNP = sampleCorner(-hx, hz)
    const hNN = sampleCorner(-hx, -hz)

    const avgH = (hPP + hPN + hNP + hNN) * 0.25

    // ⚠️ شیب‌ها + clamp
    const hRight = (hPP + hPN) * 0.5
    const hLeft = (hNP + hNN) * 0.5
    const rawSlopeX = (hRight - hLeft) / (2 * hx)
    const slopeX = Math.max(-MAX_SLOPE_TAN, Math.min(MAX_SLOPE_TAN, rawSlopeX))

    const hFront = (hPP + hNP) * 0.5
    const hBack = (hPN + hNN) * 0.5
    const rawSlopeZ = (hFront - hBack) / (2 * hz)
    const slopeZ = Math.max(-MAX_SLOPE_TAN, Math.min(MAX_SLOPE_TAN, rawSlopeZ))

    const targetRoll = Math.atan(slopeX)
    const targetPitch = -Math.atan(slopeZ)

    const a = 1 - Math.exp(-this.tiltSmoothing * dt)
    v.targetTiltX = v.targetTiltX * (1 - a) + targetPitch * a
    v.targetTiltZ = v.targetTiltZ * (1 - a) + targetRoll * a

    v.tiltPivot.rotation.x = v.targetTiltX
    v.tiltPivot.rotation.z = v.targetTiltZ

    v.targetY = avgH + this.yOffset

    if (!v.initialized) {
      pos.y = v.targetY
      v.velocityY = 0
      v.initialized = true
      return
    }

    v.velocityY -= this.gravity * dt
    pos.y += v.velocityY * dt

    if (pos.y <= v.targetY) {
      pos.y = v.targetY
      v.velocityY = 0
    }
  }

  // ---------------------------------------------------------------
  // Spawn
  // ---------------------------------------------------------------

  private spawnFromGltf(source: THREE.Object3D, options: VehicleSystemOptions) {
    source.updateMatrixWorld(true)
    const candidates: THREE.Object3D[] =
      source.children.length > 0 ? [...source.children] : [source]

    console.log(
      `[VehicleSystem] Found ${candidates.length} top-level node(s):`,
      candidates.map((c) => c.name || '(unnamed)')
    )

    const useOriginal = options.useOriginalScale ?? true
    const targetSize = options.targetSize ?? 4.5
    const globalScale = options.scaleMultiplier ?? 1
    const castShadow = options.castShadow ?? true
    const receiveShadow = options.receiveShadow ?? true

    const placements =
      options.placements ??
      this.generateScatterPlacements(
        candidates.length,
        options.scatterRadius ?? 30
      )

    for (let i = 0; i < candidates.length; i++) {
      const original = candidates[i]
      const clone = original.clone(true) as THREE.Object3D
      clone.name = original.name || `vehicle_${i + 1}`

      // reset transforms
      clone.position.set(0, 0, 0)
      clone.rotation.set(0, 0, 0)
      clone.updateMatrixWorld(true)

      // --- ۱) bbox دقیق از vertexهای واقعی ---
      const box1 = computeAccurateBBox(clone)
      if (box1.isEmpty()) {
        console.warn(`[VehicleSystem] "${clone.name}" has no visible geometry, skip`)
        continue
      }
      const size1 = box1.getSize(new THREE.Vector3())
      const maxDim = Math.max(size1.x, size1.y, size1.z) || 1

      const placement = placements[i % placements.length]
      const finalMultiplier = (placement.scale ?? 1) * globalScale

      if (useOriginal) {
        clone.scale.setScalar(finalMultiplier)
      } else {
        clone.scale.setScalar((targetSize / maxDim) * finalMultiplier)
      }
      clone.updateMatrixWorld(true)

      // --- ۲) bbox دقیق بعد از مقیاس ---
      const box2 = computeAccurateBBox(clone)
      const center2 = box2.getCenter(new THREE.Vector3())
      const size2 = box2.getSize(new THREE.Vector3())

      console.log(
        `[VehicleSystem] "${clone.name}" size: (${size2.x.toFixed(2)}, ${size2.y.toFixed(2)}, ${size2.z.toFixed(2)})`
      )

      // recenter افقی
      clone.position.x -= center2.x
      clone.position.z -= center2.z
      // کف روی 0
      clone.position.y -= box2.min.y
      clone.updateMatrixWorld(true)

      // --- ۳) سایه‌ها ---
      clone.traverse((obj) => {
        const m = obj as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = castShadow
          m.receiveShadow = receiveShadow
        }
      })

      // --- ۴) سلسله‌مراتب ---
      const tiltPivot = new THREE.Group()
      tiltPivot.add(clone)

      const yawPivot = new THREE.Group()
      yawPivot.add(tiltPivot)

      const root = new THREE.Group()
      root.name = clone.name
      root.add(yawPivot)

      // footprint بر اساس ابعاد واقعی
      const footprintX = (size2.x / 2) * this.footprintRatio
      const footprintZ = (size2.z / 2) * this.footprintRatio

      const yaw = placement.rotY ?? Math.random() * Math.PI * 2
      yawPivot.rotation.y = yaw

      const initialY = this.sampleHeight(placement.x, placement.z) + this.yOffset
      root.position.set(placement.x, initialY, placement.z)

      this.scene.add(root)

      root.updateMatrixWorld(true)
      const finalBox = new THREE.Box3().setFromObject(root)

      this.vehicles.push({
        name: clone.name,
        root,
        yawPivot,
        tiltPivot,
        bbox: finalBox,
        halfX: footprintX,
        halfZ: footprintZ,
        velocityY: 0,
        targetY: initialY,
        targetTiltX: 0,
        targetTiltZ: 0,
        initialized: false,
      })
    }

    options.onLoaded?.(this.getNames())
  }

  private generateScatterPlacements(
    count: number,
    radius: number
  ): VehiclePlacement[] {
    const placements: VehiclePlacement[] = []
    if (count <= 0) return placements

    const baseStep = (Math.PI * 2) / count
    for (let i = 0; i < count; i++) {
      const angle = i * baseStep + (Math.random() - 0.5) * 0.2
      const r = radius * (0.7 + Math.random() * 0.3)
      placements.push({
        x: Math.cos(angle) * r,
        z: Math.sin(angle) * r,
        rotY: Math.random() * Math.PI * 2,
      })
    }
    return placements
  }
}