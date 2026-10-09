import type { Metadata } from 'next'
import SessionIndexViewer from '@/components/jsonl/SessionIndexViewer'

export const metadata: Metadata = {
  title: 'Indexed Sessions | JSONL Browser',
  description: 'Browse preprocessed, searchable Claude Code sessions',
}

export default function SessionsPage() {
  return (
    <main className="h-screen overflow-hidden">
      <SessionIndexViewer />
    </main>
  )
}
