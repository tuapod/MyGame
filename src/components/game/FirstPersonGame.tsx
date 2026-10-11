'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * FirstPersonGame
 * A minimal first-person walk-around sandbox.
 * - Infinite Unity-like gray ground (grid + soft shading)
 * - WASD movement, mouse look, Space to jump, Shift to sprint
 * - Sky-blue gradient background + hemisphere light
 */
export default function FirstPersonGame() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [locked, setLocked] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const controlsRef = useRef<PointerLockControls | null>(null)

  // State shared between React UI and the render loop
  const lockedRef = useRef(false)
  useEffect(() => {
    lockedRef.current = locked
  }, [locked])

  // Hotbar: 4 slots (slot 1 holds a pickaxe). -1 means nothing selected.
  const HOTBAR_SIZE = 4
  const HOTBAR_ITEMS: Array<{ icon: string | null }> = [
    { icon: '/pickaxe.png' }, // slot 1: pickaxe
    { icon: null }, // slot 2: empty
    { icon: null }, // slot 3: empty
    { icon: null }, // slot 4: empty
  ]
  const [selectedSlot, setSelectedSlot] = useState<number>(-1)
  const selectedSlotRef = useRef(-1)
  useEffect(() => {
    selectedSlotRef.current = selectedSlot
  }, [selectedSlot])

  // Listen for hotbar selection keys (1-4). Pressing the same key again
  // toggles the slot off (returns to "nothing selected").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      let idx = -1
      if (e.code === 'Digit1') idx = 0
      else if (e.code === 'Digit2') idx = 1
      else if (e.code === 'Digit3') idx = 2
      else if (e.code === 'Digit4') idx = 3
      if (idx >= 0) {
        setSelectedSlot((prev) => (prev === idx ? -1 : idx))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Mouse wheel cycles through hotbar slots (only when pointer is locked).
  // Wraps around from last -> first and first -> last.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!lockedRef.current) return
      const dir = e.deltaY > 0 ? 1 : -1
      setSelectedSlot((prev) => {
        if (prev === -1) return dir > 0 ? 0 : HOTBAR_SIZE - 1
        return (prev + dir + HOTBAR_SIZE) % HOTBAR_SIZE
      })
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    // ---------- Scene ----------
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x9ec7e2) // soft sky blue
    scene.fog = new THREE.Fog(0x9ec7e2, 60, 220)

    // ---------- Camera ----------
    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      2000
    )
    camera.position.set(0, 1.7, 0) // eye height ~1.7m

    // ---------- Renderer ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    // ---------- Lights ----------
    const hemi = new THREE.HemisphereLight(0xddeeff, 0x6b6b6b, 0.9)
    scene.add(hemi)

    const sun = new THREE.DirectionalLight(0xffffff, 1.4)
    sun.position.set(50, 80, 30)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 400
    sun.shadow.camera.left = -120
    sun.shadow.camera.right = 120
    sun.shadow.camera.top = 120
    sun.shadow.camera.bottom = -120
    sun.shadow.bias = -0.0005
    scene.add(sun)

    // ---------- Ground (chunked terrain, generates out of view) ----------
    // The world is divided into square chunks. We keep a grid of chunks around
    // the player and recycle far chunks to new positions when the player
    // crosses a chunk boundary. Because recycled chunks are placed at the far
    // edge of the grid (deep in fog), the player never sees terrain pop in.
    const CHUNK_SIZE = 80 // world units per chunk
    const CHUNK_SEGMENTS = 48 // 48x48 verts per chunk (~1.67 units/vert)
    const GRID_RADIUS = 3 // 7x7 = 49 chunks around the player

    const terrainParams: TerrainParams = SHARED_TERRAIN

    const dirtTexture = makeDirtTexture()
    dirtTexture.wrapS = THREE.RepeatWrapping
    dirtTexture.wrapT = THREE.RepeatWrapping
    // Repeat per chunk so texture density is consistent everywhere
    dirtTexture.repeat.set(CHUNK_SIZE / 6, CHUNK_SIZE / 6)
    dirtTexture.anisotropy = renderer.capabilities.getMaxAnisotropy()

    const chunkMat = new THREE.MeshStandardMaterial({
      map: dirtTexture,
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
    })

    interface Chunk {
      mesh: THREE.Mesh
      gridX: number
      gridZ: number
    }

    // Pool of chunk meshes (reused, never created/destroyed during play)
    const chunks: Chunk[] = []

    // Bake heights into a chunk's geometry for its world position.
    function bakeChunk(chunk: Chunk, gridX: number, gridZ: number) {
      const geo = chunk.mesh.geometry as THREE.BufferGeometry
      const pos = geo.attributes.position as THREE.BufferAttribute
      const worldOffsetX = gridX * CHUNK_SIZE
      const worldOffsetZ = gridZ * CHUNK_SIZE
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i)
        const lz = pos.getZ(i)
        pos.setY(i, sampleTerrainHeight(worldOffsetX + lx, worldOffsetZ + lz, terrainParams.seed))
      }
      pos.needsUpdate = true
      geo.computeVertexNormals()
      chunk.mesh.position.set(worldOffsetX, 0, worldOffsetZ)
      chunk.gridX = gridX
      chunk.gridZ = gridZ
    }

    // Initial bake: fill the 7x7 grid centered on origin
    {
      let idx = 0
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++) {
          const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SEGMENTS, CHUNK_SEGMENTS)
          geo.rotateX(-Math.PI / 2)
          const mesh = new THREE.Mesh(geo, chunkMat)
          mesh.receiveShadow = true
          scene.add(mesh)
          const chunk: Chunk = { mesh, gridX: 0, gridZ: 0 }
          bakeChunk(chunk, dx, dz)
          chunks.push(chunk)
          idx++
        }
      }
    }

    // Update visible chunks based on player's current grid cell.
    // Recycles chunks that fell out of the grid to the newly-needed slots.
    function updateChunks(playerGridX: number, playerGridZ: number) {
      // Build the set of desired grid coordinates around the player
      const desired = new Set<string>()
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++) {
          desired.add(`${playerGridX + dx},${playerGridZ + dz}`)
        }
      }
      // Find chunks that are no longer in the desired set (to recycle)
      const toRecycle: Chunk[] = []
      for (const chunk of chunks) {
        const key = `${chunk.gridX},${chunk.gridZ}`
        if (!desired.has(key)) toRecycle.push(chunk)
      }
      // Find desired slots that don't have a chunk yet
      const occupied = new Set(chunks.map((c) => `${c.gridX},${c.gridZ}`))
      const missing: Array<[number, number]> = []
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++) {
          const gx = playerGridX + dx
          const gz = playerGridZ + dz
          if (!occupied.has(`${gx},${gz}`)) missing.push([gx, gz])
        }
      }
      // Recycle: assign each missing slot to a recycled chunk and re-bake.
      // The missing slots are at the far edge of the grid (deep in fog),
      // so the player never sees this happen.
      for (let i = 0; i < toRecycle.length && i < missing.length; i++) {
        bakeChunk(toRecycle[i], missing[i][0], missing[i][1])
      }
    }

    // Spawn the player on top of the terrain at origin
    camera.position.set(0, sampleTerrainHeight(0, 0, 1337) + 1.7, 0)

    // ---------- Controls ----------
    const controls = new PointerLockControls(camera, renderer.domElement)
    controlsRef.current = controls
    scene.add(controls.object)

    controls.addEventListener('lock', () => setLocked(true))
    controls.addEventListener('unlock', () => setLocked(false))

    // ---------- Held item (3D pickaxe loaded from GLB, follows camera) ----------
    // Structure:
    //   pickaxe (outer)  -> follows camera position + orientation
    //   swingPivot (inner) -> applies swing rotation around the hand (handle bottom)
    //   model -> offset upward so handle bottom sits at swingPivot origin
    const pickaxe = new THREE.Group()
    pickaxe.visible = false
    scene.add(pickaxe)
    const swingPivot = new THREE.Group()
    pickaxe.add(swingPivot)
    const heldItemRef = { pickaxe, swingPivot }
    // View-space offset: right, down, forward (relative to camera facing)
    const heldOffset = new THREE.Vector3(0.55, -0.3, -1.0)

    // Load the pickaxe model from the GLB file
    const gltfLoader = new GLTFLoader()
    gltfLoader.load(
      '/pickaxe.glb',
      (gltf) => {
        const model = gltf.scene

        // 1) Orient so handle runs along +Y with the head on top.
        orientHandleUp(model)

        // 2) Scale to a comfortable first-person size.
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        model.scale.setScalar((1.0 / maxDim) * 0.5)
        model.updateMatrixWorld(true)

        // 3) Re-center, then shift up so the handle bottom sits at the
        //    swingPivot origin. This makes swing rotation pivot around the
        //    hand grip, so the head arcs forward while the handle stays put.
        const box2 = new THREE.Box3().setFromObject(model)
        const center2 = box2.getCenter(new THREE.Vector3())
        const modelHeight = box2.getSize(new THREE.Vector3()).y
        model.position.x -= center2.x
        model.position.y -= center2.y
        model.position.z -= center2.z
        model.position.y += modelHeight / 2

        // 4) Face the camera (both prongs visible) by rotating around Y.
        //    Applied to the MODEL itself, so swing rotation (on swingPivot)
        //    happens BEFORE the face turn — keeping the chop in the vertical
        //    screen plane. Uses rotateY (multiplies onto orientHandleUp's
        //    quaternion) rather than overwriting rotation directly.
        model.rotateY(Math.PI / 2)

        // Enable shadows on all meshes
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh
            mesh.castShadow = true
            mesh.receiveShadow = true
          }
        })
        swingPivot.add(model)
      },
      undefined,
      (err) => {
        console.error('[pickaxe] Failed to load /pickaxe.glb:', err)
      }
    )

    // ---------- Movement ----------
    const velocity = new THREE.Vector3()
    const direction = new THREE.Vector3()
    const move = { forward: false, backward: false, left: false, right: false, jump: false, sprint: false }
    let canJump = false

    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          move.forward = true
          break
        case 'KeyS':
        case 'ArrowDown':
          move.backward = true
          break
        case 'KeyA':
        case 'ArrowLeft':
          move.left = true
          break
        case 'KeyD':
        case 'ArrowRight':
          move.right = true
          break
        case 'Space':
          move.jump = true
          break
        case 'ShiftLeft':
        case 'ShiftRight':
          move.sprint = true
          break
        case 'Escape':
          controls.unlock()
          break
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          move.forward = false
          break
        case 'KeyS':
        case 'ArrowDown':
          move.backward = false
          break
        case 'KeyA':
        case 'ArrowLeft':
          move.left = false
          break
        case 'KeyD':
        case 'ArrowRight':
          move.right = false
          break
        case 'Space':
          move.jump = false
          break
        case 'ShiftLeft':
        case 'ShiftRight':
          move.sprint = false
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    // ---------- Swing (left-click attack) ----------
    // When the player left-clicks while holding the pickaxe, we trigger a
    // swing animation: the pickaxe rotates forward then back, like a strike.
    let swingTime = -1 // -1 = idle; >=0 = animation progress in seconds
    const SWING_DURATION = 0.45 // total swing time in seconds
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return // only left click
      if (!lockedRef.current) return // ignore when not playing
      if (selectedSlotRef.current !== 0) return // only when pickaxe selected
      if (swingTime >= 0 && swingTime < SWING_DURATION) return // not re-trigger mid-swing
      swingTime = 0
    }
    window.addEventListener('mousedown', onMouseDown)

    // ---------- Animation Loop ----------
    const clock = new THREE.Clock()
    let raf = 0
    let firstFrame = true
    let lastPlayerGridX = 0
    let lastPlayerGridZ = 0
    let bobPhase = 0 // walking bob phase for held item

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(clock.getDelta(), 0.1)

      // Friction / damping
      velocity.x -= velocity.x * 10 * dt
      velocity.z -= velocity.z * 10 * dt
      velocity.y -= 25 * dt // gravity

      direction.z = Number(move.forward) - Number(move.backward)
      direction.x = Number(move.right) - Number(move.left)
      direction.normalize()

      const speed = move.sprint ? 22 : 10

      if (move.forward || move.backward) velocity.z -= direction.z * speed * dt * 10
      if (move.left || move.right) velocity.x -= direction.x * speed * dt * 10

      // Only move when pointer is locked (so menus don't drift the player)
      if (lockedRef.current) {
        controls.moveRight(-velocity.x * dt)
        controls.moveForward(-velocity.z * dt)
      }

      // Vertical (jump / gravity)
      controls.object.position.y += velocity.y * dt

      // Ground collision: sample terrain elevation at player's (x, z)
      const eyeHeight = 1.7
      const px = controls.object.position.x
      const pz = controls.object.position.z
      const groundY = sampleTerrainHeight(px, pz, terrainParams.seed)
      const floorY = groundY + eyeHeight
      if (controls.object.position.y < floorY) {
        velocity.y = 0
        controls.object.position.y = floorY
        canJump = true
      }

      // Stream chunks: when the player crosses into a new grid cell, recycle
      // far chunks to new positions at the far edge of the grid. Because the
      // grid radius (3 chunks * 80 units = 240 units) extends beyond the fog
      // end (220), newly-baked chunks are always hidden in fog — no pop-in.
      const playerGridX = Math.round(px / CHUNK_SIZE)
      const playerGridZ = Math.round(pz / CHUNK_SIZE)
      if (playerGridX !== lastPlayerGridX || playerGridZ !== lastPlayerGridZ) {
        updateChunks(playerGridX, playerGridZ)
        lastPlayerGridX = playerGridX
        lastPlayerGridZ = playerGridZ
      }

      // Held item visibility + bob/sway animation.
      // Show the pickaxe only when slot 0 (pickaxe) is selected.
      const isHolding = selectedSlotRef.current === 0
      if (heldItemRef.pickaxe.visible !== isHolding) {
        heldItemRef.pickaxe.visible = isHolding
      }
      if (isHolding) {
        // Walking bob: detect horizontal movement speed
        const horizSpeed = Math.hypot(velocity.x, velocity.z)
        const walking = horizSpeed > 0.5 && canJump
        if (walking) {
          bobPhase += dt * (move.sprint ? 14 : 9)
        } else {
          bobPhase += dt * 2
        }
        const bobY = walking ? Math.sin(bobPhase * 2) * 0.025 : 0
        const bobX = walking ? Math.cos(bobPhase) * 0.02 : 0
        const swayZ = walking ? Math.sin(bobPhase) * 0.04 : 0

        // Swing animation: advance the swing timer and compute a rotation
        // curve that goes from 0 -> forward strike -> back to 0.
        // No wind-up: the pickaxe chops straight down from the front.
        let swingRot = 0
        if (swingTime >= 0) {
          swingTime += dt
          if (swingTime >= SWING_DURATION) {
            swingTime = -1 // animation finished, return to idle
          } else {
            const t = swingTime / SWING_DURATION // 0..1
            // Sine envelope so motion starts and ends at 0 smoothly.
            const envelope = Math.sin(t * Math.PI) // 0..1..0
            // Strike forward only (positive), peak ~1.4 rad (~80deg).
            swingRot = envelope * 1.4
          }
        }

        // Position the pickaxe in front of the camera using camera basis vectors
        const camQuat = camera.quaternion
        const offset = new THREE.Vector3(
          heldOffset.x + bobX,
          heldOffset.y + bobY,
          heldOffset.z
        )
        offset.applyQuaternion(camQuat)
        heldItemRef.pickaxe.position.copy(camera.position).add(offset)
        heldItemRef.pickaxe.quaternion.copy(camQuat)
        // Swing rotation pivots around the handle (hand). Positive rotation
        // around X makes the head swing forward/down in front of the player.
        heldItemRef.swingPivot.rotation.x = swingRot
      }

      // Jump
      if (move.jump && canJump && lockedRef.current) {
        velocity.y = 9
        canJump = false
      }

      renderer.render(scene, camera)

      if (firstFrame) {
        firstFrame = false
        setLoaded(true)
      }
    }
    animate()

    // ---------- Resize ----------
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)

    // ---------- Cleanup ----------
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      for (const chunk of chunks) {
        chunk.mesh.geometry.dispose()
      }
      chunkMat.dispose()
      dirtTexture.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [])

  // Click overlay to lock pointer
  const handleStart = () => {
    controlsRef.current?.lock()
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black">
      {/* 3D mount */}
      <div ref={mountRef} className="absolute inset-0" />

      {/* Crosshair */}
      {locked && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-white/80 shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
        </div>
      )}

      {/* HUD top-left */}
      {locked && (
        <div className="absolute top-4 left-4 pointer-events-none select-none">
          <div className="rounded-md bg-black/40 backdrop-blur px-3 py-2 text-xs text-white/90 font-mono">
            WASD: حرکت | Mouse: نگاه | Shift: دویدن | Space: پرش | Esc: خروج
          </div>
        </div>
      )}

      {/* Hotbar — 4 slots, bottom center */}
      {locked && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none select-none">
          <Hotbar items={HOTBAR_ITEMS} selected={selectedSlot} />
        </div>
      )}

      {/* Loading */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900 text-white">
          <div className="text-lg">در حال بارگذاری محیط…</div>
        </div>
      )}

      {/* Start / unlock overlay */}
      {loaded && !locked && (
        <div
          onClick={handleStart}
          className="absolute inset-0 flex flex-col items-center justify-center cursor-pointer bg-gradient-to-b from-black/60 to-black/80 backdrop-blur-sm text-white"
        >
          <div className="text-center px-6">
            <h1 className="text-4xl sm:text-5xl font-bold mb-4 tracking-tight">
              محیط اول‌شخص
            </h1>
            <p className="text-base sm:text-lg text-white/80 mb-8 max-w-md">
              روی این صفحه کلیک کن تا موس قفل بشه و بتونی راه بری و سرت رو بچرخونی.
            </p>
            <div className="inline-flex items-center gap-2 rounded-lg bg-white text-black px-6 py-3 font-semibold text-lg hover:bg-white/90 transition">
              شروع بازی
            </div>
            <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm text-white/80">
              <KeyHint k="W A S D" label="حرکت" />
              <KeyHint k="Mouse" label="چرخش دوربین" />
              <KeyHint k="Shift" label="دویدن" />
              <KeyHint k="Space" label="پرش" />
              <KeyHint k="1 - 4" label="انتخاب هات‌بار" />
              <KeyHint k="Esc" label="خروج از موس" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-white/10 px-3 py-2">
      <span className="font-mono font-semibold text-white">{k}</span>
      <span className="text-white/70">— {label}</span>
    </div>
  )
}

/**
 * Hotbar
 * A clean 4-slot hotbar at the bottom of the screen. Each slot can hold an
 * item icon (or be empty). The selected slot is highlighted; when nothing is
 * selected (selected === -1), no slot is highlighted.
 */
function Hotbar({
  items,
  selected,
}: {
  items: Array<{ icon: string | null }>
  selected: number
}) {
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-black/35 backdrop-blur-md px-3 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.5)] ring-1 ring-white/10">
      {items.map((item, i) => {
        const isActive = i === selected
        return (
          <div
            key={i}
            className={[
              'relative flex items-center justify-center',
              'w-14 h-14 rounded-xl',
              'transition-all duration-150',
              isActive
                ? 'bg-white/15 ring-2 ring-white/90 scale-105 shadow-[0_0_16px_rgba(255,255,255,0.25)]'
                : 'bg-white/5 ring-1 ring-white/10',
            ].join(' ')}
          >
            {/* Slot number badge */}
            <span
              className={[
                'absolute top-1 left-1.5 text-[10px] font-mono font-semibold leading-none',
                isActive ? 'text-white/90' : 'text-white/40',
              ].join(' ')}
            >
              {i + 1}
            </span>
            {/* Item icon or empty well */}
            {item.icon ? (
              <img
                src={item.icon}
                alt=""
                className="w-10 h-10 object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
                draggable={false}
              />
            ) : (
              <div className="w-9 h-9 rounded-lg bg-gradient-to-b from-white/[0.04] to-black/30 ring-1 ring-inset ring-white/5" />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * makeDirtTexture
 * Procedurally generates a seamless dark-brown dirt texture on a canvas.
 * Layers:
 *  1. Base dark-brown fill
 *  2. Value noise (multi-octave) for clumps / variations
 *  3. Speckles (small pebbles / grains)
 *  4. Lighter cracks/veins for organic feel
 * Output is a CanvasTexture, tileable because noise is value-noise sampled
 * with wrapping coordinates.
 */
function makeDirtTexture(): THREE.CanvasTexture {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  // Base dark brown
  ctx.fillStyle = '#3a2716'
  ctx.fillRect(0, 0, size, size)

  // Helper: tileable pseudo-random value noise
  const rand = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return n - Math.floor(n)
  }
  const smooth = (t: number) => t * t * (3 - 2 * t)
  // Value noise with bilinear interpolation, tileable with period = size
  const valueNoise = (x: number, y: number) => {
    const xi = Math.floor(x) % size
    const yi = Math.floor(y) % size
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const x0 = (xi + size) % size
    const y0 = (yi + size) % size
    const x1 = (xi + 1) % size
    const y1 = (yi + 1) % size
    const v00 = rand(x0, y0)
    const v10 = rand(x1, y0)
    const v01 = rand(x0, y1)
    const v11 = rand(x1, y1)
    const u = smooth(xf)
    const v = smooth(yf)
    return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v
  }
  // Fractal (multi-octave) value noise
  const fbm = (x: number, y: number, octaves: number) => {
    let sum = 0
    let amp = 0.5
    let freq = 1
    for (let i = 0; i < octaves; i++) {
      sum += amp * valueNoise(x * freq, y * freq)
      freq *= 2
      amp *= 0.5
    }
    return sum
  }

  // Paint pixel-by-pixel using ImageData for performance and control
  const img = ctx.createImageData(size, size)
  const data = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.06, y * 0.06, 5) // large clumps
      const n2 = fbm(x * 0.25, y * 0.25, 3) // medium grain
      const n3 = rand(x, y) // fine noise

      // Base dirt color: dark brown (#3a2716) -> mid brown (#5a3a1f) -> lighter (#7a542c)
      let r = 58 + n * 70 + n2 * 20
      let g = 39 + n * 50 + n2 * 14
      let b = 22 + n * 30 + n2 * 8

      // Add dark spots (wet/darker dirt patches)
      const dark = Math.pow(fbm(x * 0.04 + 10, y * 0.04 + 10, 4), 2.5)
      r -= dark * 30
      g -= dark * 22
      b -= dark * 14

      // Fine grain speckle
      r += (n3 - 0.5) * 18
      g += (n3 - 0.5) * 14
      b += (n3 - 0.5) * 10

      // Clamp
      data[(y * size + x) * 4 + 0] = Math.max(0, Math.min(255, r))
      data[(y * size + x) * 4 + 1] = Math.max(0, Math.min(255, g))
      data[(y * size + x) * 4 + 2] = Math.max(0, Math.min(255, b))
      data[(y * size + x) * 4 + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  // Add a few lighter "crack" veins for organic feel
  ctx.strokeStyle = 'rgba(120, 88, 50, 0.35)'
  ctx.lineWidth = 1
  for (let i = 0; i < 18; i++) {
    ctx.beginPath()
    let cx = Math.random() * size
    let cy = Math.random() * size
    ctx.moveTo(cx, cy)
    const steps = 8 + Math.floor(Math.random() * 8)
    for (let s = 0; s < steps; s++) {
      cx += (Math.random() - 0.5) * 40
      cy += (Math.random() - 0.5) * 40
      ctx.lineTo(cx, cy)
    }
    ctx.stroke()
  }

  // Small pebble specks (lighter & darker)
  for (let i = 0; i < 220; i++) {
    const px = Math.random() * size
    const py = Math.random() * size
    const pr = 0.6 + Math.random() * 1.6
    const dark = Math.random() > 0.5
    ctx.fillStyle = dark ? 'rgba(30, 18, 8, 0.6)' : 'rgba(120, 92, 56, 0.5)'
    ctx.beginPath()
    ctx.arc(px, py, pr, 0, Math.PI * 2)
    ctx.fill()
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// Terrain height system
// ---------------------------------------------------------------------------
// A deterministic, hash-based value-noise so that:
//   - terrainifyGeometry() bakes heights into the mesh vertices
//   - sampleTerrainHeight(x, z) returns the SAME height at runtime for the
//     player's collision, so walking feels consistent with what you see.
// Using multiple octaves + a ridge component makes the terrain feel random
// and varied (hills + bumps + sharper ridges), not a smooth sine wave.

function hash2(x: number, y: number, seed: number): number {
  // Deterministic pseudo-random in [0,1) from integer coords + seed
  let h = Math.sin(x * 127.1 + y * 311.7 + seed * 0.013) * 43758.5453
  return h - Math.floor(h)
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const v00 = hash2(xi, yi, seed)
  const v10 = hash2(xi + 1, yi, seed)
  const v01 = hash2(xi, yi + 1, seed)
  const v11 = hash2(xi + 1, yi + 1, seed)
  const u = smoothstep(xf)
  const v = smoothstep(yf)
  return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v
}

function fbm(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + i * 17)
    norm += amp
    freq *= 2
    amp *= 0.5
  }
  return sum / norm
}

// Ridged noise: produces sharper ridge lines instead of smooth hills.
function ridged(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, y * freq, seed + i * 31)
    // ridge = 1 - |2n-1|, then squared to sharpen
    const r = 1 - Math.abs(2 * n - 1)
    sum += amp * r * r
    norm += amp
    freq *= 2
    amp *= 0.5
  }
  return sum / norm
}

interface TerrainParams {
  baseHeight: number
  amplitude: number
  frequency: number
  octaves: number
  ridgeWeight: number // 0..1, how much ridged noise to mix in
  seed: number
}

// The single source of truth for terrain height at a world (x, z).
// Uses the same params as the mesh baking so collision matches visuals.
const SHARED_TERRAIN: TerrainParams = {
  baseHeight: 0,
  amplitude: 7,
  frequency: 0.022,
  octaves: 5,
  ridgeWeight: 0.4,
  seed: 1337,
}

function sampleTerrainHeight(x: number, z: number, _seed?: number): number {
  return sampleTerrainHeightWithParams(x, z, SHARED_TERRAIN)
}

function sampleTerrainHeightWithParams(x: number, z: number, p: TerrainParams): number {
  const fx = x * p.frequency
  const fz = z * p.frequency
  const smoothN = fbm(fx, fz, p.octaves, p.seed)
  const ridgeN = ridged(fx, fz, p.octaves, p.seed + 999)
  // Blend smooth + ridged for organic-but-varied terrain
  const combined = smoothN * (1 - p.ridgeWeight) + ridgeN * p.ridgeWeight
  // combined is roughly in [0,1]; center around 0 and scale by amplitude
  return p.baseHeight + (combined - 0.5) * 2 * p.amplitude
}

// Mutates geometry vertices to apply terrain height. Geometry must already be
// rotated so it lies on the XZ plane (Y is up).
function terrainifyGeometry(geo: THREE.BufferGeometry, p: TerrainParams): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const y = sampleTerrainHeightWithParams(x, z, p)
    pos.setY(i, y)
  }
  pos.needsUpdate = true
}

/**
 * orientHandleUp
 * Rotates a model so its longest axis (the handle) points along +Y with the
 * head (the wider end) on top, and the head's bar runs along +X.
 * Works from the actual vertices, so it doesn't depend on how the GLB was authored.
 */
function orientHandleUp(model: THREE.Object3D): void {
  model.updateMatrixWorld(true)

  // Collect all vertices in model space
  const pts: THREE.Vector3[] = []
  model.traverse((child) => {
    const m = child as THREE.Mesh
    if (!m.isMesh) return
    const p = m.geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      pts.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld))
    }
  })
  if (pts.length === 0) return

  const box = new THREE.Box3().setFromPoints(pts)
  const size = box.getSize(new THREE.Vector3())
  const dims = [size.x, size.y, size.z]
  const order = [0, 1, 2].sort((a, b) => dims[b] - dims[a])
  const handleIdx = order[0] // longest axis = handle
  const barIdx = order[1] // second longest = head bar

  const comp = (v: THREE.Vector3, i: number) => (i === 0 ? v.x : i === 1 ? v.y : v.z)
  const hMin = comp(box.min, handleIdx)
  const hLen = dims[handleIdx]

  // Measure how wide the model is at each end of the handle axis.
  // The head end has the larger cross-section along the bar axis.
  let loMin = Infinity, loMax = -Infinity, hiMin = Infinity, hiMax = -Infinity
  for (const v of pts) {
    const t = (comp(v, handleIdx) - hMin) / hLen
    const w = comp(v, barIdx)
    if (t < 0.15) { loMin = Math.min(loMin, w); loMax = Math.max(loMax, w) }
    else if (t > 0.85) { hiMin = Math.min(hiMin, w); hiMax = Math.max(hiMax, w) }
  }
  const headAtMax = hiMax - hiMin >= loMax - loMin
  const sign = headAtMax ? 1 : -1

  const h = new THREE.Vector3()
  const b = new THREE.Vector3()
  if (handleIdx === 0) h.x = sign; else if (handleIdx === 1) h.y = sign; else h.z = sign
  if (barIdx === 0) b.x = 1; else if (barIdx === 1) b.y = 1; else b.z = 1

  // Rotation that sends: bar -> +X, handle (toward head) -> +Y
  const z = new THREE.Vector3().crossVectors(b, h)
  const basis = new THREE.Matrix4().makeBasis(b, h, z) // columns: target -> local
  model.quaternion.setFromRotationMatrix(basis.transpose()) // local -> target
  model.updateMatrixWorld(true)
}
