import { BrowserRouter, Link, Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { RoomsPage } from '@/pages/rooms-page'
import { RoomLivePage } from '@/pages/room-live-page'
import { RoomEditPage } from '@/pages/room-edit-page'

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <div className="min-h-svh bg-background text-foreground">
          <header className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
            <Link to="/" className="text-lg font-semibold">
              Switchy
            </Link>
            <span className="text-sm text-muted-foreground">automatic camera switching</span>
          </header>
          <Separator />
          <main className="mx-auto max-w-6xl px-4 py-6">
            <Routes>
              <Route path="/" element={<RoomsPage />} />
              <Route path="/rooms/new" element={<RoomEditPage />} />
              <Route path="/rooms/:id" element={<RoomLivePage />} />
              <Route path="/rooms/:id/edit" element={<RoomEditPage />} />
            </Routes>
          </main>
        </div>
        <Toaster richColors />
      </TooltipProvider>
    </BrowserRouter>
  )
}
