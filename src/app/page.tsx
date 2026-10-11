'use client'

import dynamic from 'next/dynamic'

// Load the 3D game only on the client (Three.js needs window/DOM)
const FirstPersonGame = dynamic(() => import('@/components/game/FirstPersonGame'), {
  ssr: false,
  loading: () => (
    <div className="w-screen h-screen flex items-center justify-center bg-zinc-900 text-white">
      <div className="text-lg">در حال بارگذاری محیط…</div>
    </div>
  ),
})

export default function Home() {
  return <FirstPersonGame />
}
