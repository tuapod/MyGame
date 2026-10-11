import * as THREE from 'three'

export interface Dig {
  x: number
  z: number
  radius: number
  depth: number
}

export interface DigSystemOptions {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  baseSampleHeight: (x: number, z: number) => number
  /** Material used for crater meshes (should support polygonOffset). */
  craterMaterial?: THREE.Material
  /** World size that corresponds to a UV of 1.0 (should equal CHUNK_SIZE). */
  craterUvScale?: number
  /** Number of concentric rings in each crater mesh. */
  craterRings?: number
  /** Number of angular sectors in each crater mesh. */
  craterSectors?: number
  maxDigs?: number
  digReach?: number
  radiusRange?: [number, number]
  depthRange?: [number, number]
}

interface ParticlePool {
  points: THREE.Points
  positions: Float32Array
  velocities: Float32Array
  lives: Float32Array
  maxLives: Float32Array
  count: number
  next: number
  gravity: number
}

export class DigSystem {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private baseSampleHeight: (x: number, z: number) => number

  private digs: Dig[] = []
  private craters: THREE.Mesh[] = []
  private maxDigs: number
  private digReach: number
  private radiusRange: [number, number]
  private depthRange: [number, number]

  private craterMaterial: THREE.Material | null
  private craterUvScale: number
  private craterRings: number
  private craterSectors: number

  private getChunkMeshes: (() => THREE.Mesh[]) | null = null
  private rebakeChunksNear: ((x: number, z: number, radius: number) => void) | null = null

  private raycaster = new THREE.Raycaster()
  private screenCenter = new THREE.Vector2(0, 0)

  private dust!: ParticlePool
  private chunks!: ParticlePool

  private flash!: THREE.Sprite
  private flashLife = 0
  private readonly FLASH_DURATION = 0.16

  private shakeTime = 0
  private readonly SHAKE_DURATION = 0.25
  private readonly SHAKE_ROT = 0.028
  private readonly SHAKE_POS = 0.05

  constructor(options: DigSystemOptions) {
    this.scene = options.scene
    this.camera = options.camera
    this.baseSampleHeight = options.baseSampleHeight
    this.maxDigs = options.maxDigs ?? 220
    this.digReach = options.digReach ?? 4.5
    this.radiusRange = options.radiusRange ?? [1.3, 1.6]
    this.depthRange = options.depthRange ?? [0.5, 0.7]

    this.craterMaterial = options.craterMaterial ?? null
    this.craterUvScale = options.craterUvScale ?? 80
    this.craterRings = options.craterRings ?? 16
    this.craterSectors = options.craterSectors ?? 28

    // ---- Particle pools ----
    this.dust = this.createPool({
      count: 90,
      color: 0x8a6a45,
      size: 0.06,
      opacity: 0.7,
      gravity: 4.5,
    })
    this.chunks = this.createPool({
      count: 50,
      color: 0x3a2510,
      size: 0.17,
      opacity: 1.0,
      gravity: 22,
    })

    // ---- Impact flash ----
    const flashMat = new THREE.SpriteMaterial({
      color: 0xffe0a0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.flash = new THREE.Sprite(flashMat)
    this.flash.scale.set(0.3, 0.3, 1)
    this.flash.visible = false
    this.scene.add(this.flash)
  }

  private createPool(opts: {
    count: number
    color: number
    size: number
    opacity: number
    gravity: number
  }): ParticlePool {
    const count = opts.count
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lives = new Float32Array(count)
    const maxLives = new Float32Array(count)
    for (let i = 0; i < count; i++) positions[i * 3 + 1] = -10000

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const mat = new THREE.PointsMaterial({
      color: opts.color,
      size: opts.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: opts.opacity,
      depthWrite: false,
    })

    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false
    this.scene.add(points)

    return {
      points,
      positions,
      velocities,
      lives,
      maxLives,
      count,
      next: 0,
      gravity: opts.gravity,
    }
  }

  setChunkProvider(
    getChunkMeshes: () => THREE.Mesh[],
    rebakeChunksNear: (x: number, z: number, radius: number) => void
  ) {
    this.getChunkMeshes = getChunkMeshes
    this.rebakeChunksNear = rebakeChunksNear
  }

  sampleHeight(x: number, z: number): number {
    let h = this.baseSampleHeight(x, z)
    for (let i = 0; i < this.digs.length; i++) {
      const dig = this.digs[i]
      const dx = x - dig.x
      const dz = z - dig.z
      const d2 = dx * dx + dz * dz
      const r2 = dig.radius * dig.radius
      if (d2 < r2) {
        const t = Math.sqrt(d2) / dig.radius
        const falloff = 1 - t * t * (3 - 2 * t) // smoothstep inverse
        h -= dig.depth * falloff
      }
    }
    return h
  }

  tryImpact(): THREE.Vector3 | null {
    if (!this.getChunkMeshes || !this.rebakeChunksNear) return null

    this.raycaster.setFromCamera(this.screenCenter, this.camera)
    this.raycaster.far = this.digReach

    const hits = this.raycaster.intersectObjects(this.getChunkMeshes(), false)
    if (hits.length === 0) return null

    const point = hits[0].point

    const radius =
      this.radiusRange[0] +
      Math.random() * (this.radiusRange[1] - this.radiusRange[0])
    const depth =
      this.depthRange[0] +
      Math.random() * (this.depthRange[1] - this.depthRange[0])

    const dig: Dig = { x: point.x, z: point.z, radius, depth }
    this.digs.push(dig)

    // Crater mesh (high-res patch that renders over the terrain)
    if (this.craterMaterial) {
      const crater = this.createCraterMesh(dig)
      this.craters.push(crater)
      this.scene.add(crater)
    } else {
      this.craters.push(null as unknown as THREE.Mesh)
    }

    if (this.digs.length > this.maxDigs) {
      this.digs.shift()
      const old = this.craters.shift()
      if (old) {
        this.scene.remove(old)
        old.geometry.dispose()
      }
    }

    // Rebake the base terrain under the crater so collision & shadows line up.
    this.rebakeChunksNear(point.x, point.z, radius + 1)

    // Visual feedback
    this.spawnDust(point, 14)
    this.spawnChunks(point, 10)

    this.flash.position.copy(point)
    this.flash.visible = true
    this.flashLife = this.FLASH_DURATION
    ;(this.flash.material as THREE.SpriteMaterial).opacity = 0.95

    this.shakeTime = this.SHAKE_DURATION

    return point
  }

  update(dt: number) {
    this.updatePool(this.dust, dt)
    this.updatePool(this.chunks, dt)
    this.updateFlash(dt)
    if (this.shakeTime > 0) this.shakeTime -= dt
  }

  getShake(): { x: number; y: number; z: number; rotZ: number } {
    if (this.shakeTime <= 0) return { x: 0, y: 0, z: 0, rotZ: 0 }
    const t = this.shakeTime / this.SHAKE_DURATION
    const decay = t * t
    const phase = (1 - t) * Math.PI * 9
    const phaseY = (1 - t) * Math.PI * 11

    return {
      x: Math.cos(phase) * decay * this.SHAKE_POS * 0.5,
      y: Math.sin(phase * 1.3) * decay * this.SHAKE_POS,
      z: Math.cos(phaseY) * decay * this.SHAKE_POS * 0.4,
      rotZ: Math.sin(phase) * decay * this.SHAKE_ROT,
    }
  }

  dispose() {
    this.scene.remove(this.dust.points)
    this.scene.remove(this.chunks.points)
    this.dust.points.geometry.dispose()
    ;(this.dust.points.material as THREE.Material).dispose()
    this.chunks.points.geometry.dispose()
    ;(this.chunks.points.material as THREE.Material).dispose()
    this.scene.remove(this.flash)
    ;(this.flash.material as THREE.Material).dispose()

    for (const c of this.craters) {
      if (c) {
        this.scene.remove(c)
        c.geometry.dispose()
      }
    }
    this.craters.length = 0
    this.digs.length = 0
  }

  // ----------------------------------------------------------------
  // Crater mesh generation
  // ----------------------------------------------------------------

  private createCraterMesh(dig: Dig): THREE.Mesh {
    const geo = this.buildCraterGeometry(dig)
    const mesh = new THREE.Mesh(geo, this.craterMaterial!)
    mesh.receiveShadow = true
    mesh.castShadow = false
    return mesh
  }

  private buildCraterGeometry(dig: Dig): THREE.BufferGeometry {
    const R = this.craterRings
    const S = this.craterSectors
    // Slightly larger than the dig radius so it covers the deformed terrain.
    const outerR = dig.radius * 1.08
    const uvScale = this.craterUvScale

    const vertCount = 1 + R * S
    const positions = new Float32Array(vertCount * 3)
    const uvs = new Float32Array(vertCount * 2)
    const indices: number[] = []

    // Center vertex
    const cy = this.sampleHeight(dig.x, dig.z)
    positions[0] = dig.x
    positions[1] = cy
    positions[2] = dig.z
    uvs[0] = dig.x / uvScale
    uvs[1] = dig.z / uvScale

    // Rings: 0..R, with a power curve so vertices are denser near the center
    for (let r = 1; r <= R; r++) {
      const rr = Math.pow(r / R, 0.9) * outerR
      for (let s = 0; s < S; s++) {
        const angle = (s / S) * Math.PI * 2
        const x = dig.x + Math.cos(angle) * rr
        const z = dig.z + Math.sin(angle) * rr
        const y = this.sampleHeight(x, z)
        const idx = 1 + (r - 1) * S + s
        positions[idx * 3 + 0] = x
        positions[idx * 3 + 1] = y
        positions[idx * 3 + 2] = z
        uvs[idx * 2 + 0] = x / uvScale
        uvs[idx * 2 + 1] = z / uvScale
      }
    }

    // Center fan (reverse order so the normal points up)
    for (let s = 0; s < S; s++) {
      const next = (s + 1) % S
      indices.push(0, 1 + next, 1 + s)
    }

    // Quad rings
    for (let r = 1; r < R; r++) {
      for (let s = 0; s < S; s++) {
        const next = (s + 1) % S
        const a = 1 + (r - 1) * S + s
        const b = 1 + (r - 1) * S + next
        const c = 1 + r * S + s
        const d = 1 + r * S + next
        indices.push(a, b, c)
        indices.push(b, d, c)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    return geo
  }

  // ----------------------------------------------------------------
  // Particles
  // ----------------------------------------------------------------

  private spawnDust(origin: THREE.Vector3, count: number) {
    const pool = this.dust
    for (let i = 0; i < count; i++) {
      const idx = pool.next
      pool.next = (pool.next + 1) % pool.count
      const i3 = idx * 3

      pool.positions[i3 + 0] = origin.x + (Math.random() - 0.5) * 0.35
      pool.positions[i3 + 1] = origin.y + 0.05
      pool.positions[i3 + 2] = origin.z + (Math.random() - 0.5) * 0.35

      const angle = Math.random() * Math.PI * 2
      const outward = 0.3 + Math.random() * 0.9
      pool.velocities[i3 + 0] = Math.cos(angle) * outward
      pool.velocities[i3 + 1] = 0.8 + Math.random() * 1.6
      pool.velocities[i3 + 2] = Math.sin(angle) * outward

      const life = 0.9 + Math.random() * 0.7
      pool.lives[idx] = life
      pool.maxLives[idx] = life
    }
    pool.points.geometry.attributes.position.needsUpdate = true
  }

  private spawnChunks(origin: THREE.Vector3, count: number) {
    const pool = this.chunks
    for (let i = 0; i < count; i++) {
      const idx = pool.next
      pool.next = (pool.next + 1) % pool.count
      const i3 = idx * 3

      pool.positions[i3 + 0] = origin.x + (Math.random() - 0.5) * 0.25
      pool.positions[i3 + 1] = origin.y + 0.1
      pool.positions[i3 + 2] = origin.z + (Math.random() - 0.5) * 0.25

      const dir = new THREE.Vector3(
        (Math.random() - 0.5) * 1.2,
        0.8 + Math.random() * 1.2,
        (Math.random() - 0.5) * 1.2
      ).normalize()
      const speed = 3.2 + Math.random() * 2.5
      pool.velocities[i3 + 0] = dir.x * speed
      pool.velocities[i3 + 1] = dir.y * speed
      pool.velocities[i3 + 2] = dir.z * speed

      const life = 0.6 + Math.random() * 0.5
      pool.lives[idx] = life
      pool.maxLives[idx] = life
    }
    pool.points.geometry.attributes.position.needsUpdate = true
  }

  private updatePool(pool: ParticlePool, dt: number) {
    let anyAlive = false
    for (let i = 0; i < pool.count; i++) {
      if (pool.lives[i] <= 0) continue
      anyAlive = true
      pool.lives[i] -= dt
      const i3 = i * 3

      pool.velocities[i3 + 1] -= pool.gravity * dt
      const drag = 1 - Math.min(dt * 0.8, 0.5)
      pool.velocities[i3 + 0] *= drag
      pool.velocities[i3 + 2] *= drag

      pool.positions[i3 + 0] += pool.velocities[i3 + 0] * dt
      pool.positions[i3 + 1] += pool.velocities[i3 + 1] * dt
      pool.positions[i3 + 2] += pool.velocities[i3 + 2] * dt

      if (pool.lives[i] <= 0) {
        pool.positions[i3 + 1] = -10000
      }
    }
    if (anyAlive) {
      pool.points.geometry.attributes.position.needsUpdate = true
    }
  }

  private updateFlash(dt: number) {
    if (this.flashLife <= 0) {
      if (this.flash.visible) this.flash.visible = false
      return
    }
    this.flashLife -= dt
    const t = 1 - this.flashLife / this.FLASH_DURATION
    const mat = this.flash.material as THREE.SpriteMaterial
    mat.opacity = Math.pow(1 - t, 1.6) * 0.95
    const s = 0.3 + t * 0.9
    this.flash.scale.set(s, s, 1)
    if (this.flashLife <= 0) this.flash.visible = false
  }
}