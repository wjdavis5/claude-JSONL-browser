'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUpDown,
  Calendar,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit2,
  Eye,
  File,
  FileCheck,
  FileText,
  FolderOpen,
  HardDrive,
  Layers,
  Menu,
  Search,
  Trash2,
  Type,
  Upload,
  X,
} from 'lucide-react'
import { cn, formatFileDate, formatFileSize, generateFileId } from '@/lib/utils'
import { CompareView } from '@/components/jsonl/CompareView'
import { parseClaudeJsonl } from '@/lib/jsonl/parse'
import { renderMarkdown } from '@/lib/jsonl/renderMarkdown'
import { renderPreview } from '@/lib/jsonl/renderPreview'
import { renderSafeOriginal } from '@/lib/jsonl/renderSafeOriginal'
import { renderSafeText } from '@/lib/jsonl/renderSafeText'
import type { ParseResult, PreviewModel, EventRole } from '@/lib/jsonl/types'

type UploadedFile = File

interface FileData {
  id: string
  name: string
  content: string
  markdown: string | null
  fullMarkdown: string | null
  parseResult: ParseResult | null
  preview: PreviewModel | null
  lastModified: number
  size: number
  converted: boolean
  error?: string
}

interface SearchResult {
  matches: number
  snippets: Array<{
    lineNumber: number
    text: string
  }>
}

type ViewMode = 'transcript' | 'compare'

const roleStyles: Record<EventRole, string> = {
  user: 'border-everforest-green/40 bg-everforest-bg-green/40 text-everforest-green',
  assistant: 'border-everforest-blue/40 bg-everforest-bg-blue/40 text-everforest-blue',
  summary: 'border-everforest-purple/40 bg-everforest-bg-visual/40 text-everforest-purple',
  system: 'border-everforest-yellow/40 bg-everforest-bg-yellow/40 text-everforest-yellow',
  progress: 'border-everforest-aqua/40 bg-everforest-bg-green/30 text-everforest-aqua',
  metadata: 'border-everforest-grey0/40 bg-everforest-bg2 text-everforest-grey2',
  unknown: 'border-everforest-red/40 bg-everforest-bg-red/40 text-everforest-red',
}

const sortOptions = [
  { value: 'date-desc', label: 'Date (Newest)', icon: Calendar },
  { value: 'date-asc', label: 'Date (Oldest)', icon: Calendar },
  { value: 'name-asc', label: 'Name (A-Z)', icon: Type },
  { value: 'name-desc', label: 'Name (Z-A)', icon: Type },
  { value: 'size-desc', label: 'Size (Largest)', icon: HardDrive },
  { value: 'size-asc', label: 'Size (Smallest)', icon: HardDrive },
]

const directoryInputProps = {
  webkitdirectory: '',
  directory: '',
} as Record<string, string>

export default function JsonlConverter() {
  const [files, setFiles] = useState<FileData[]>([])
  const [sidecarFiles, setSidecarFiles] = useState<Record<string, string>>({})
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [searchResults, setSearchResults] = useState<Record<string, SearchResult>>({})
  const [convertAllProgress, setConvertAllProgress] = useState<number | null>(null)
  const [sortOrder, setSortOrder] = useState('date-desc')
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [editingFileName, setEditingFileName] = useState('')
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('transcript')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const checkScreenSize = () => {
      const width = window.innerWidth
      setIsMobile(width < 640)
      if (width < 640) setSidebarOpen(false)
    }

    checkScreenSize()
    window.addEventListener('resize', checkScreenSize)
    return () => window.removeEventListener('resize', checkScreenSize)
  }, [])

  useEffect(() => {
    if (!editingFileId || !editInputRef.current) return

    editInputRef.current.focus()
    const lastDotIndex = editInputRef.current.value.lastIndexOf('.')
    if (lastDotIndex > 0) {
      editInputRef.current.setSelectionRange(0, lastDotIndex)
    } else {
      editInputRef.current.select()
    }
  }, [editingFileId])

  useEffect(() => {
    setViewMode('transcript')
  }, [selectedFileId])

  useEffect(() => {
    if (!searchTerm.trim()) {
      setSearchResults({})
      return
    }

    const searchLower = searchTerm.toLowerCase()
    const results: Record<string, SearchResult> = {}

    files.forEach((file) => {
      let matches = 0
      const snippets: SearchResult['snippets'] = []

      if (file.name.toLowerCase().includes(searchLower)) matches++

      file.content.split('\n').forEach((line, index) => {
        if (!line.toLowerCase().includes(searchLower)) return
        matches++
        if (snippets.length < 3) {
          snippets.push({
            lineNumber: index + 1,
            text: line.substring(0, 100) + (line.length > 100 ? '...' : ''),
          })
        }
      })

      const renderedText = [
        file.markdown || '',
        ...(file.preview?.items.map((item) => `${item.title} ${item.body} ${item.chips.join(' ')}`) || []),
      ].join('\n')

      if (renderedText.toLowerCase().includes(searchLower)) matches++
      if (matches > 0) results[file.id] = { matches, snippets }
    })

    setSearchResults(results)
  }, [searchTerm, files])

  const sortedFiles = useMemo(() => {
    const filesCopy = [...files]

    switch (sortOrder) {
      case 'date-desc':
        return filesCopy.sort((a, b) => b.lastModified - a.lastModified)
      case 'date-asc':
        return filesCopy.sort((a, b) => a.lastModified - b.lastModified)
      case 'name-asc':
        return filesCopy.sort((a, b) => a.name.localeCompare(b.name))
      case 'name-desc':
        return filesCopy.sort((a, b) => b.name.localeCompare(a.name))
      case 'size-desc':
        return filesCopy.sort((a, b) => b.size - a.size)
      case 'size-asc':
        return filesCopy.sort((a, b) => a.size - b.size)
      default:
        return filesCopy
    }
  }, [files, sortOrder])

  const currentFile = useMemo(
    () => files.find((file) => file.id === selectedFileId) || null,
    [files, selectedFileId],
  )

  const currentFileContent = currentFile?.content || ''
  const currentFileMarkdown = currentFile?.markdown || ''

  const safeOriginal = useMemo(
    () => (currentFileContent ? renderSafeOriginal(currentFileContent) : ''),
    [currentFileContent],
  )

  const safeMarkdown = useMemo(
    () => (currentFileMarkdown ? renderSafeText(currentFileMarkdown) : ''),
    [currentFileMarkdown],
  )

  const convertedCount = files.filter((file) => file.converted).length
  const sidecarCount = Object.keys(sidecarFiles).length

  useEffect(() => {
    if (viewMode === 'compare' && !currentFile?.markdown) {
      setViewMode('transcript')
    }
  }, [currentFile?.markdown, viewMode])

  const handleRenameStart = (fileId: string, currentName: string) => {
    setEditingFileId(fileId)
    setEditingFileName(currentName)
  }

  const handleRenameSave = () => {
    const trimmedName = editingFileName.trim()
    if (!trimmedName) {
      handleRenameCancel()
      return
    }

    const isDuplicate = files.some((file) => file.id !== editingFileId && file.name === trimmedName)
    if (isDuplicate) {
      showError('A file with this name already exists')
      return
    }

    setFiles((previous) => previous.map((file) => (file.id === editingFileId ? { ...file, name: trimmedName } : file)))
    handleRenameCancel()
  }

  const handleRenameCancel = () => {
    setEditingFileId(null)
    setEditingFileName('')
  }

  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      handleRenameSave()
    }
    if (event.key === 'Escape') handleRenameCancel()
  }

  const handleFilesUpload = async (uploadedFiles: FileList | File[]) => {
    const incoming = Array.from(uploadedFiles) as UploadedFile[]
    if (incoming.length === 0) return

    setError('')
    setNotice('')

    const sidecarCandidates = incoming.filter(isSidecarFile)
    const logCandidates = incoming.filter((file) => !isSidecarFile(file) && isConversationLog(file))

    const newSidecars: Record<string, string> = {}
    await Promise.all(
      sidecarCandidates.map(async (file) => {
        const text = await file.text()
        const path = file.webkitRelativePath || file.name
        newSidecars[path] = text
        newSidecars[file.name] = text
      }),
    )

    const mergedSidecars = { ...sidecarFiles, ...newSidecars }
    if (Object.keys(newSidecars).length > 0) {
      setSidecarFiles(mergedSidecars)
      setFiles((previous) =>
        previous.map((file) =>
          file.converted
            ? {
                ...file,
                converted: false,
                markdown: null,
                fullMarkdown: null,
                parseResult: null,
                preview: null,
              }
            : file,
        ),
      )
    }

    const newFiles: FileData[] = await Promise.all(
      logCandidates.map(async (file) => ({
        id: generateFileId(),
        name: displayName(file),
        content: await file.text(),
        markdown: null,
        fullMarkdown: null,
        parseResult: null,
        preview: null,
        lastModified: file.lastModified,
        size: file.size,
        converted: false,
      })),
    )

    if (newFiles.length > 0) {
      setFiles((previous) => [...previous, ...newFiles])
      if (!selectedFileId) setSelectedFileId(newFiles[0].id)
    }

    if (newFiles.length === 0 && Object.keys(newSidecars).length > 0) {
      setNotice('Loaded sidecar files. Convert the JSONL files again to include full tool outputs.')
    } else if (newFiles.length === 0) {
      showError('No JSONL files found.')
    } else if (Object.keys(newSidecars).length > 0) {
      setNotice(`Loaded ${newFiles.length} conversation file${newFiles.length === 1 ? '' : 's'} and sidecar outputs.`)
    }
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)
    if (event.dataTransfer.files.length > 0) {
      void handleFilesUpload(event.dataTransfer.files)
    }
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)
  }

  const convertFile = (file: FileData): FileData => {
    const parseResult = parseClaudeJsonl(file.content, { sidecarFiles })
    const markdown = renderMarkdown(parseResult, 'readable')
    const fullMarkdown = renderMarkdown(parseResult, 'full')
    const preview = renderPreview(parseResult)

    return {
      ...file,
      markdown,
      fullMarkdown,
      parseResult,
      preview,
      converted: true,
      error: undefined,
    }
  }

  const convertCurrentFile = () => {
    if (!currentFile) {
      showError('No file selected')
      return
    }

    try {
      const converted = convertFile(currentFile)
      setFiles((previous) => previous.map((file) => (file.id === currentFile.id ? converted : file)))
      setError('')
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Could not convert this file')
    }
  }

  const convertAllFiles = async () => {
    if (files.length === 0) return

    setConvertAllProgress(0)
    const updatedFiles: FileData[] = []

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      try {
        updatedFiles.push(convertFile(file))
      } catch (error) {
        updatedFiles.push({
          ...file,
          error: error instanceof Error ? error.message : 'Could not convert this file',
        })
      }
      setConvertAllProgress(Math.round(((index + 1) / files.length) * 100))
    }

    setFiles(updatedFiles)
    setTimeout(() => setConvertAllProgress(null), 800)
  }

  const deleteFile = (fileId: string) => {
    setFiles((previous) => previous.filter((file) => file.id !== fileId))
    if (selectedFileId === fileId) {
      const remaining = files.filter((file) => file.id !== fileId)
      setSelectedFileId(remaining[0]?.id || null)
    }
  }

  const clearAllFiles = () => {
    setFiles([])
    setSidecarFiles({})
    setSelectedFileId(null)
    setSearchResults({})
    setNotice('')
    setError('')
  }

  const exportAllMarkdown = (mode: 'readable' | 'full') => {
    const sections = files
      .filter((file) => (mode === 'full' ? file.fullMarkdown : file.markdown))
      .map((file) => `# File: ${file.name}\n\n${mode === 'full' ? file.fullMarkdown : file.markdown}`)

    downloadMarkdown(
      `combined-${mode}-export-${new Date().toISOString().slice(0, 10)}.md`,
      sections.join('\n\n---\n\n') || '# Combined JSONL Exports\n\nNo converted files.',
    )
  }

  const copyToClipboard = async () => {
    if (!currentFile?.markdown) return

    try {
      await navigator.clipboard.writeText(currentFile.markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showError('Could not copy the Markdown.')
    }
  }

  const showError = (message: string) => {
    setError(message)
    setTimeout(() => setError(''), 3000)
  }

  return (
    <div className="h-screen bg-everforest-bg0 flex overflow-hidden">
      <aside
        className={cn(
          'w-full sm:w-[300px] sm:min-w-[300px] bg-everforest-bg-dim border-r border-everforest-bg4 flex flex-col',
          'absolute sm:relative h-screen transition-all duration-300 z-50 sm:z-0',
          sidebarOpen ? 'left-0' : '-left-full sm:-left-[300px]',
        )}
      >
        <div className="p-4 border-b border-everforest-bg4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 min-w-0">
              <FolderOpen className="w-5 h-5 text-everforest-green flex-shrink-0" />
              <div className="min-w-0">
                <h2 className="text-base font-medium text-everforest-fg">Files ({files.length})</h2>
                <p className="text-xs text-everforest-grey1">{sidecarCount} sidecar file{sidecarCount === 1 ? '' : 's'}</p>
              </div>
            </div>
            {isMobile && (
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="p-1 hover:bg-everforest-bg1 rounded transition-colors"
                aria-label="Close sidebar"
              >
                <X className="w-5 h-5 text-everforest-grey1" />
              </button>
            )}
          </div>

          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-everforest-grey1" />
            <input
              type="text"
              placeholder="Search files"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-everforest-bg0 border border-everforest-bg4 rounded-md text-everforest-fg text-sm outline-none focus:border-everforest-green transition-colors"
            />
          </div>

          {files.length > 1 && (
            <div className="relative mb-3">
              <button
                type="button"
                onClick={() => setSortDropdownOpen((value) => !value)}
                className="w-full px-3 py-2 bg-everforest-bg2 text-everforest-fg border border-everforest-bg4 rounded-md text-xs flex items-center justify-between hover:bg-everforest-bg3 transition-colors"
              >
                <span className="flex items-center gap-1">
                  <ArrowUpDown className="w-3.5 h-3.5" />
                  {sortOptions.find((option) => option.value === sortOrder)?.label || 'Sort'}
                </span>
                {sortDropdownOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>

              {sortDropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-everforest-bg1 border border-everforest-bg4 rounded-md shadow-lg z-10 overflow-hidden">
                  {sortOptions.map((option) => {
                    const Icon = option.icon
                    return (
                      <button
                        type="button"
                        key={option.value}
                        onClick={() => {
                          setSortOrder(option.value)
                          setSortDropdownOpen(false)
                        }}
                        className={cn(
                          'w-full px-3 py-2 text-xs flex items-center gap-2 text-left transition-colors',
                          sortOrder === option.value ? 'bg-everforest-bg2 text-everforest-green' : 'text-everforest-fg hover:bg-everforest-bg2',
                        )}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 mb-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 bg-everforest-bg2 text-everforest-blue border border-everforest-bg4 rounded-md text-xs flex items-center justify-center gap-1 hover:bg-everforest-bg3 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              Add Files
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="px-3 py-2 bg-everforest-bg2 text-everforest-aqua border border-everforest-bg4 rounded-md text-xs flex items-center justify-center gap-1 hover:bg-everforest-bg3 transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Project Folder
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".jsonl,.json"
              onChange={(event) => event.target.files && void handleFilesUpload(event.target.files)}
              className="hidden"
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              {...directoryInputProps}
              onChange={(event) => event.target.files && void handleFilesUpload(event.target.files)}
              className="hidden"
            />
          </div>

          {files.length > 0 && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                type="button"
                onClick={() => void convertAllFiles()}
                className="px-3 py-2 bg-everforest-bg-green text-everforest-green border border-everforest-green/30 rounded-md text-xs flex items-center justify-center gap-1 hover:bg-everforest-bg-green/80 transition-colors"
              >
                {convertAllProgress !== null ? `${convertAllProgress}%` : <><FileCheck className="w-3.5 h-3.5" />Convert All</>}
              </button>
              <button
                type="button"
                onClick={clearAllFiles}
                className="px-3 py-2 bg-everforest-bg-red text-everforest-red border border-everforest-red/30 rounded-md text-xs flex items-center justify-center gap-1 hover:bg-everforest-bg-red/80 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            </div>
          )}

          {convertedCount > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => exportAllMarkdown('readable')}
                className="px-3 py-2 bg-everforest-bg-blue text-everforest-blue border border-everforest-blue/30 rounded-md text-xs flex items-center justify-center gap-1 hover:bg-everforest-bg-blue/80 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Readable
              </button>
              <button
                type="button"
                onClick={() => exportAllMarkdown('full')}
                className="px-3 py-2 bg-everforest-bg-blue text-everforest-blue border border-everforest-blue/30 rounded-md text-xs flex items-center justify-center gap-1 hover:bg-everforest-bg-blue/80 transition-colors"
              >
                <Layers className="w-3.5 h-3.5" />
                Full
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
          {files.length === 0 ? (
            <div className="p-4 text-center text-everforest-grey1 text-sm">
              Upload JSONL files or a Claude project folder.
            </div>
          ) : (
            sortedFiles.map((file) => {
              const isSelected = file.id === selectedFileId
              const hasSearchMatch = searchResults[file.id]
              const isEditing = editingFileId === file.id

              return (
                <div
                  key={file.id}
                  onClick={() => !isEditing && handleFileSelect(file.id, isMobile, setSelectedFileId, setSidebarOpen)}
                  className={cn(
                    'p-3 mb-1 rounded-md cursor-pointer transition-all border',
                    isSelected
                      ? 'bg-everforest-bg2 border-everforest-green'
                      : hasSearchMatch
                        ? 'bg-everforest-bg1 border-transparent hover:bg-everforest-bg2'
                        : 'border-transparent hover:bg-everforest-bg1',
                  )}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <File className={cn('w-4 h-4 flex-shrink-0', file.converted ? 'text-everforest-green' : 'text-everforest-yellow')} />
                      {isEditing ? (
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editingFileName}
                          onChange={(event) => setEditingFileName(event.target.value)}
                          onBlur={handleRenameSave}
                          onKeyDown={handleRenameKeyDown}
                          onClick={(event) => event.stopPropagation()}
                          className="flex-1 min-w-0 px-2 py-1 bg-everforest-bg0 border border-everforest-green rounded text-everforest-fg text-sm outline-none"
                        />
                      ) : (
                        <span className="text-sm text-everforest-fg truncate flex-1">{file.name}</span>
                      )}
                    </div>
                    <FileActions
                      isEditing={isEditing}
                      onSave={handleRenameSave}
                      onCancel={handleRenameCancel}
                      onRename={() => handleRenameStart(file.id, file.name)}
                      onDelete={() => deleteFile(file.id)}
                    />
                  </div>

                  <div className="text-xs text-everforest-grey1 flex items-center gap-2 flex-wrap">
                    <span>{formatFileSize(file.size)}</span>
                    <span>/</span>
                    <span>{formatFileDate(file.lastModified)}</span>
                    {file.converted && <span className="text-everforest-green">Converted</span>}
                    {file.error && <span className="text-everforest-red">Error</span>}
                  </div>

                  {file.preview && (
                    <div className="mt-2 text-xs text-everforest-grey1">
                      {file.preview.summary.accountedRecords}/{file.preview.summary.totalRecords} records
                      {file.preview.summary.missingSidecars > 0 && (
                        <span className="text-everforest-yellow"> / {file.preview.summary.missingSidecars} missing sidecar</span>
                      )}
                    </div>
                  )}

                  {hasSearchMatch && (
                    <div className="mt-2 text-xs text-everforest-blue">
                      {hasSearchMatch.matches} match{hasSearchMatch.matches === 1 ? '' : 'es'}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </aside>

      <section className="flex-1 flex flex-col overflow-hidden">
        <header className="px-4 py-3 border-b border-everforest-bg4 bg-everforest-bg1 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {(!sidebarOpen || isMobile) && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="p-1 hover:bg-everforest-bg2 rounded transition-colors"
                aria-label="Open sidebar"
              >
                <Menu className="w-5 h-5 text-everforest-fg" />
              </button>
            )}
            <FileText className="w-6 h-6 text-everforest-green flex-shrink-0" />
            <h1 className="text-lg sm:text-xl font-medium text-everforest-fg truncate">JSONL Browser</h1>
            <a
              href="/sessions"
              className="px-3 py-1.5 bg-everforest-bg2 text-everforest-aqua border border-everforest-bg4 rounded-md text-xs flex items-center gap-1.5 hover:bg-everforest-bg3 transition-colors"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Indexed Sessions</span>
            </a>
          </div>

          {currentFile?.markdown && (
            <button
              type="button"
              onClick={() => void copyToClipboard()}
              className="px-3 py-2 bg-everforest-bg2 text-everforest-blue border border-everforest-bg4 rounded-md text-sm flex items-center gap-2 hover:bg-everforest-bg3 transition-colors"
            >
              {copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          )}
        </header>

        <div
          className="flex-1 p-4 sm:p-5 overflow-hidden flex flex-col"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {isDragging && (
            <div className="fixed inset-0 bg-everforest-bg-blue/95 flex items-center justify-center z-[9999]">
              <div className="p-8 bg-everforest-bg1 rounded-lg border-2 border-dashed border-everforest-blue text-center">
                <Upload className="w-12 h-12 text-everforest-blue mx-auto mb-4" />
                <p className="text-everforest-fg text-lg">Drop JSONL files here</p>
              </div>
            </div>
          )}

          {!currentFile ? (
            <EmptyState onChooseFiles={() => fileInputRef.current?.click()} onChooseFolder={() => folderInputRef.current?.click()} />
          ) : (
            <div className="flex flex-col gap-3 h-full overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base text-everforest-fg truncate">{currentFile.name}</h2>
                  <div className="mt-1 flex items-center gap-2 text-xs text-everforest-grey1">
                    <span>{formatFileSize(currentFile.size)}</span>
                    <span>/</span>
                    <span>{formatFileDate(currentFile.lastModified)}</span>
                    {currentFile.converted && <span className="text-everforest-green">Converted</span>}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {currentFile.markdown && (
                    <>
                      <button
                        type="button"
                        onClick={() => downloadMarkdown(`${baseName(currentFile.name)}-readable.md`, currentFile.markdown || '')}
                        className="px-3 py-2 bg-everforest-bg2 text-everforest-blue border border-everforest-bg4 rounded-md text-xs flex items-center gap-1 hover:bg-everforest-bg3 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Readable
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadMarkdown(`${baseName(currentFile.name)}-full.md`, currentFile.fullMarkdown || '')}
                        className="px-3 py-2 bg-everforest-bg2 text-everforest-aqua border border-everforest-bg4 rounded-md text-xs flex items-center gap-1 hover:bg-everforest-bg3 transition-colors"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        Full
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={convertCurrentFile}
                    className="px-4 py-2 bg-everforest-green text-everforest-bg0 rounded-md text-sm font-medium hover:bg-everforest-green/90 transition-colors"
                  >
                    {currentFile.converted ? 'Reconvert' : 'Convert'}
                  </button>
                </div>
              </div>

              {(error || notice || currentFile.error) && (
                <StatusMessage error={error || currentFile.error} notice={notice} />
              )}

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <h2 className="text-base text-everforest-fg">{viewMode === 'compare' ? 'Compare' : 'Transcript'}</h2>

                {currentFile.markdown && (
                  <div className="p-1 rounded-lg bg-everforest-bg1 border border-everforest-bg4 flex items-center gap-1">
                    <ViewModeButton active={viewMode === 'transcript'} onClick={() => setViewMode('transcript')}>
                      Transcript
                    </ViewModeButton>
                    <ViewModeButton active={viewMode === 'compare'} onClick={() => setViewMode('compare')}>
                      Compare
                    </ViewModeButton>
                  </div>
                )}
              </div>

              {viewMode === 'compare' && currentFile.markdown ? (
                <div className="w-full flex-1 min-h-[260px] overflow-hidden">
                  <CompareView fileId={currentFile.id} originalText={safeOriginal} markdownText={safeMarkdown} />
                </div>
              ) : (
                <div className="w-full flex-1 min-h-[220px] bg-everforest-bg2 border border-everforest-bg4 rounded-lg overflow-auto custom-scrollbar">
                  {currentFile.preview ? (
                    <PreviewPane preview={currentFile.preview} />
                  ) : (
                    <div className="h-full flex items-center justify-center text-everforest-grey1 text-sm px-6 text-center">
                      Convert the file to see a clean transcript.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function ViewModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-h-8 px-3 rounded-md text-xs font-medium transition-colors',
        active
          ? 'bg-everforest-bg3 text-everforest-fg'
          : 'text-everforest-grey1 hover:text-everforest-fg hover:bg-everforest-bg2',
      )}
    >
      {children}
    </button>
  )
}

function FileActions({
  isEditing,
  onSave,
  onCancel,
  onRename,
  onDelete,
}: {
  isEditing: boolean
  onSave: () => void
  onCancel: () => void
  onRename: () => void
  onDelete: () => void
}) {
  if (isEditing) {
    return (
      <div className="flex items-center gap-1">
        <button type="button" onClick={stopAnd(onSave)} className="p-1 text-everforest-green hover:bg-everforest-bg3 rounded" aria-label="Save name">
          <Check className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={stopAnd(onCancel)} className="p-1 text-everforest-grey1 hover:bg-everforest-bg3 rounded" aria-label="Cancel rename">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={stopAnd(onRename)} className="p-1 text-everforest-grey1 opacity-70 hover:opacity-100 hover:bg-everforest-bg3 rounded transition-all" aria-label="Rename file">
        <Edit2 className="w-3.5 h-3.5" />
      </button>
      <button type="button" onClick={stopAnd(onDelete)} className="p-1 text-everforest-grey1 opacity-70 hover:opacity-100 hover:bg-everforest-bg3 rounded transition-all" aria-label="Remove file">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function EmptyState({ onChooseFiles, onChooseFolder }: { onChooseFiles: () => void; onChooseFolder: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-everforest-grey1">
      <FolderOpen className="w-16 h-16 text-everforest-grey0 mb-4" />
      <h2 className="text-2xl text-everforest-fg mb-2">No file selected</h2>
      <p className="mb-8 text-base max-w-md">Upload JSONL files, or choose the whole Claude project folder to include full tool outputs.</p>
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={onChooseFiles}
          className="px-5 py-3 bg-everforest-green text-everforest-bg0 rounded-lg text-base font-medium flex items-center gap-2 hover:bg-everforest-green/90 transition-colors"
        >
          <Upload className="w-4 h-4" />
          Choose Files
        </button>
        <button
          type="button"
          onClick={onChooseFolder}
          className="px-5 py-3 bg-everforest-blue text-everforest-bg0 rounded-lg text-base font-medium flex items-center gap-2 hover:bg-everforest-blue/90 transition-colors"
        >
          <FolderOpen className="w-4 h-4" />
          Project Folder
        </button>
      </div>
    </div>
  )
}

function StatusMessage({ error, notice }: { error?: string; notice?: string }) {
  if (!error && !notice) return null

  return (
    <div
      className={cn(
        'mt-4 p-3 border rounded-md text-sm flex items-start gap-2',
        error ? 'bg-everforest-bg-red border-everforest-red/30 text-everforest-red' : 'bg-everforest-bg-blue border-everforest-blue/30 text-everforest-blue',
      )}
    >
      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <span>{error || notice}</span>
    </div>
  )
}

function PreviewPane({ preview }: { preview: PreviewModel }) {
  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Metric label="Records" value={`${preview.summary.accountedRecords}/${preview.summary.totalRecords}`} />
        <Metric label="Hidden" value={String(preview.summary.hiddenMetadataRecords)} />
        <Metric label="Sidecars" value={`${preview.summary.resolvedSidecars}/${preview.summary.resolvedSidecars + preview.summary.missingSidecars}`} />
        <Metric label="Warnings" value={String(preview.warnings.length)} />
      </div>

      {preview.warnings.length > 0 && (
        <div className="p-3 rounded-md bg-everforest-bg-yellow border border-everforest-yellow/30 text-everforest-yellow text-sm">
          {preview.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {preview.items.map((item) => (
          <article key={item.id} className="border border-everforest-bg4 rounded-lg bg-everforest-bg1 overflow-hidden">
            <div className="p-3">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn('px-2 py-1 rounded border text-xs font-medium', roleStyles[item.role])}>{item.title}</span>
                  {item.timestamp && <span className="text-xs text-everforest-grey1 truncate">{formatEventTimestamp(item.timestamp)}</span>}
                </div>
                {item.hasDetails && (
                  <span className="text-xs text-everforest-grey1 flex items-center gap-1 flex-shrink-0">
                    <Eye className="w-3 h-3" />
                    {item.detailCount}
                  </span>
                )}
              </div>

              {item.chips.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {item.chips.slice(0, 6).map((chip) => (
                    <span key={chip} className="px-2 py-0.5 rounded bg-everforest-bg2 text-everforest-grey2 text-xs">
                      {chip}
                    </span>
                  ))}
                </div>
              )}

              <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-everforest-fg">{item.body}</pre>

              {item.hasDetails && (
                <details className="mt-3 text-sm text-everforest-grey2" open={!item.isCollapsedByDefault}>
                  <summary className="cursor-pointer select-none text-everforest-blue">Details</summary>
                  <div className="mt-2 space-y-3">
                    {item.details.map((detail, index) => (
                      <div key={`${detail.label}-${index}`} className="border border-everforest-bg4 rounded-md bg-everforest-bg0 p-3">
                        <div className="text-xs text-everforest-grey1 mb-2">{detail.label}</div>
                        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-everforest-grey2">
                          {detail.content}
                        </pre>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded-md bg-everforest-bg0 border border-everforest-bg4">
      <div className="text-xs text-everforest-grey1">{label}</div>
      <div className="text-sm text-everforest-fg font-medium">{value}</div>
    </div>
  )
}

function stopAnd(action: () => void) {
  return (event: React.MouseEvent) => {
    event.stopPropagation()
    action()
  }
}

function handleFileSelect(
  fileId: string,
  isMobile: boolean,
  setSelectedFileId: React.Dispatch<React.SetStateAction<string | null>>,
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>,
) {
  setSelectedFileId(fileId)
  if (isMobile) setSidebarOpen(false)
}

function isConversationLog(file: UploadedFile): boolean {
  const path = file.webkitRelativePath || file.name
  const normalized = path.replace(/\\/g, '/')
  if (normalized.includes('/tool-results/')) return false
  return file.name.endsWith('.jsonl') || file.name.endsWith('.json')
}

function isSidecarFile(file: UploadedFile): boolean {
  const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/')
  return file.name.endsWith('.json') && (path.includes('/tool-results/') || file.name.startsWith('toolu_'))
}

function displayName(file: UploadedFile): string {
  return file.webkitRelativePath || file.name
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '').replace(/[^\w.-]+/g, '-')
}

function downloadMarkdown(fileName: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function formatEventTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleString()
}
