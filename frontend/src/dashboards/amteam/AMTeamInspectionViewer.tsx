import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  AlertCircle,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  FileText,
  Loader2,
  Pause,
  Play,
  Search,
  Square,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  fetchAmTeamObservations,
  fetchAmTeamPipeGroups,
  fetchAmTeamPipes,
} from './api'
import type {
  AmTeamCellValue,
  AmTeamInspection,
  AmTeamInspectionMedia,
  AmTeamMediaAsset,
  AmTeamObservation,
  AmTeamPipe,
  AmTeamPipeInspectionGroup,
} from './types'
import './AMTeamInspectionViewer.css'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'
type SearchCandidate = {
  key: string
  kind: 'ProjectTitle' | 'Address'
  value: string
  detail: string
}
type MediaSourceMode = 'api' | 'p-drive'
type ElectronAwareWindow = Window & {
  electronAPI?: unknown
  process?: {
    type?: string
    versions?: {
      electron?: string
    }
  }
}
type InspectionDateOption = {
  key: string
  label: string
  dateKeys: string[]
}
type ObservationDistanceGroup = {
  key: string
  label: string
  sortValue: number
  observations: AmTeamObservation[]
}
type ObservationDefectSelection = {
  majorKey: string
  otherKeys: string[]
  amScore: string
  defectComment: string
  noHighScoreConfirmed: boolean
}
type ObservationCardEntry = {
  cardKey: string
  observation: AmTeamObservation
  observationNumber: number
}
type PipeReviewInput = {
  cloggingPercent: string
  comments: string
  cloggingSnapshotTimeSeconds: number | null
  cloggingSnapshotVideoPath: string
}
type ActiveVideoFrame = {
  videoPath: string
  videoName: string
  timeSeconds: number
}
type VideoSeekRequest = {
  id: number
  videoPath: string
  timeSeconds: number
}
type PipeObservationCacheEntry = {
  inspection: AmTeamInspection
  observations: AmTeamObservation[]
  media: AmTeamInspectionMedia
}
type ReportImage = {
  data: Uint8Array
  width: number
  height: number
}
type ReviewReportParagraph = {
  type: 'paragraph'
  text: string
  heading?: boolean
  bold?: boolean
  underline?: boolean
  fontSize?: number
  outlineLevel?: number
  alignment?: 'left' | 'center'
}
type ReviewReportElement =
  | ReviewReportParagraph
  | { type: 'image'; image: ReportImage }
type ReviewReportFormat = 'docx' | 'pdf'
type ReviewReportFile = {
  title: string
  suggestedBaseName: string
  elements: ReviewReportElement[]
}
type SaveFilePickerFileType = {
  description: string
  accept: Record<string, string[]>
}
type SaveFileHandle = {
  name: string
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void> | void
    close: () => Promise<void> | void
  }>
}
type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string
    types?: SaveFilePickerFileType[]
    excludeAcceptAllOption?: boolean
  }) => Promise<SaveFileHandle>
}

const INSPECTION_GROUP_DAY_WINDOW = 7
const DAY_IN_MS = 24 * 60 * 60 * 1000
const PIPE_REVIEW_COMMENT_OPTIONS = ['Deposit', 'Rocks']
const PIPE_REVIEW_PANEL_COMMENT_OPTIONS = ['Rocks', 'Deposit']
const DEFAULT_MAJOR_DEFECT_AM_SCORE = '3'
const EMPTY_INSPECTION_MEDIA: AmTeamInspectionMedia = {
  media_root: '',
  pipe_folder: null,
  inspection_folder: null,
  date_prefix: null,
  snapshots: [],
  videos: [],
  reports: [],
  warnings: [],
}

function emptyObservationDefectSelection(): ObservationDefectSelection {
  return {
    majorKey: '',
    otherKeys: [],
    amScore: '',
    defectComment: '',
    noHighScoreConfirmed: false,
  }
}

function emptyPipeReviewInput(): PipeReviewInput {
  return {
    cloggingPercent: '0',
    comments: '',
    cloggingSnapshotTimeSeconds: null,
    cloggingSnapshotVideoPath: '',
  }
}

function cloggingPercentNumber(input: PipeReviewInput) {
  const percent = Number(input.cloggingPercent)
  return Number.isFinite(percent) ? percent : 0
}

function pipeReviewHasClogging(input: PipeReviewInput) {
  return cloggingPercentNumber(input) > 0
}

function pipeReviewHasCloggingSnapshot(input: PipeReviewInput) {
  return Boolean(
    input.cloggingSnapshotVideoPath
      && input.cloggingSnapshotTimeSeconds !== null
      && Number.isFinite(input.cloggingSnapshotTimeSeconds),
  )
}

function pipeScopedKey(pipeId: string, key: string) {
  return `${pipeId}::${key}`
}

function pipeIdFromScopedKey(key: string) {
  return key.split('::')[0] ?? ''
}

function distanceGroupHasHighAmScore(selection?: ObservationDefectSelection) {
  if (!selection?.majorKey) return false
  const score = Number(selection.amScore || DEFAULT_MAJOR_DEFECT_AM_SCORE)
  return Number.isFinite(score) && score >= 3
}

function displayValue(value: AmTeamCellValue | undefined) {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

function compactDate(value: AmTeamCellValue | undefined) {
  const text = displayValue(value)
  if (text === '-') return text
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

function recordId(value: AmTeamCellValue | undefined) {
  return value === null || value === undefined ? '' : String(value)
}

function isElectronClient() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const electronWindow = window as ElectronAwareWindow
  return Boolean(
    navigator.userAgent.toLowerCase().includes(' electron/')
      || electronWindow.process?.versions?.electron
      || electronWindow.process?.type === 'renderer'
      || electronWindow.electronAPI,
  )
}

function mediaSourceMode() {
  return isElectronClient() ? 'p-drive' : 'api'
}

function encodeFileUrlPath(path: string) {
  return path
    .split('/')
    .filter((segment, index, segments) => segment || index === segments.length - 1)
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
}

function fileUrlFromWindowsPath(path: string) {
  const normalizedPath = path.replace(/\\/g, '/')
  if (normalizedPath.startsWith('//')) {
    return `file://${encodeFileUrlPath(normalizedPath.slice(2))}`
  }
  return `file:///${encodeFileUrlPath(normalizedPath.replace(/^\/+/, ''))}`
}

function localMediaUrl(mediaRoot: string, relativePath: string) {
  if (!mediaRoot || !relativePath) return ''
  const cleanRoot = mediaRoot.replace(/[\\/]+$/, '')
  const cleanRelativePath = relativePath.replace(/^[\\/]+/, '')
  return fileUrlFromWindowsPath(`${cleanRoot}/${cleanRelativePath}`)
}

function relativePathFromMediaApiUrl(url: string) {
  if (!url) return ''
  try {
    const parsedUrl = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
    return parsedUrl.searchParams.get('path') ?? ''
  } catch {
    return ''
  }
}

function mediaAssetViewUrl(asset: AmTeamMediaAsset, mode: MediaSourceMode, mediaRoot: string) {
  if (mode === 'p-drive') {
    return localMediaUrl(mediaRoot, asset.relative_path) || asset.url
  }
  return asset.url
}

function mediaViewUrl(url: string, mode: MediaSourceMode, mediaRoot: string) {
  if (mode === 'p-drive') {
    return localMediaUrl(mediaRoot, relativePathFromMediaApiUrl(url)) || url
  }
  return url
}

function boundedIntegerInputValue(value: string, min: number, max: number) {
  const nextValue = value.trim()
  if (nextValue === '') return ''
  if (!/^\d+$/.test(nextValue)) return null
  return String(Math.min(max, Math.max(min, Number(nextValue))))
}

function inspectionReviewDirection(direction: AmTeamCellValue | undefined) {
  return displayValue(direction).trim().toLowerCase() === 'upstream' ? 'Downstream to Upstream' : 'Upstream to Downstream'
}

function formatDistanceFeet(value: AmTeamCellValue | undefined) {
  const text = displayValue(value)
  if (text === '-') return text
  if (/\b(ft|feet)\b/i.test(text)) return text
  return `${text} feet`
}

function formatPercent(value: AmTeamCellValue | undefined) {
  const text = displayValue(value)
  if (text === '-') return text
  if (text.includes('%')) return text
  return `${text}%`
}

function formatYesNo(value: AmTeamCellValue | undefined) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(text)) return 'Yes'
  if (['false', '0', 'no', 'n'].includes(text)) return 'No'
  return displayValue(value)
}

function formatMediaTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = String(totalSeconds % 60).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${remainingSeconds}`
  return `${minutes}:${remainingSeconds}`
}

function numericValue(value: AmTeamCellValue | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function observationDistanceGroups(observations: AmTeamObservation[]) {
  const groups = new Map<string, ObservationDistanceGroup>()

  for (const observation of observations) {
    const rawLabel = displayValue(observation.distance)
    const label = formatDistanceFeet(observation.distance)
    const sortValue = numericValue(observation.distance)
    const key = Number.isFinite(sortValue) ? `distance:${sortValue}` : `distance:${rawLabel.trim().toLowerCase()}`
    const existingGroup = groups.get(key)

    if (existingGroup) {
      existingGroup.observations.push(observation)
      continue
    }

    groups.set(key, {
      key,
      label,
      sortValue,
      observations: [observation],
    })
  }

  return Array.from(groups.values()).sort((leftGroup, rightGroup) => {
    if (leftGroup.sortValue !== rightGroup.sortValue) return leftGroup.sortValue - rightGroup.sortValue
    return leftGroup.label.localeCompare(rightGroup.label, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function observationCardKey(observation: AmTeamObservation, index: number) {
  return [
    recordId(observation.mlo_id),
    recordId(observation.media_id),
    recordId(observation.full_path),
    String(index),
  ].join('|')
}

function inspectionDateKey(value: AmTeamCellValue | undefined) {
  const text = displayValue(value)
  if (text === '-') return ''
  const isoDate = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (isoDate) {
    const [, year, month, day] = isoDate
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function inspectionDateLabelFromKey(key: string) {
  if (!key) return '-'
  const date = new Date(`${key}T00:00:00`)
  if (Number.isNaN(date.getTime())) return key
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

function inspectionDateTimeFromKey(key: string) {
  const date = new Date(`${key}T00:00:00`)
  return Number.isNaN(date.getTime()) ? Number.NaN : date.getTime()
}

function inspectionPeriodLabel(dateKeys: string[]) {
  if (dateKeys.length === 0) return '-'
  const ascendingKeys = [...dateKeys].sort((left, right) => left.localeCompare(right))
  const firstKey = ascendingKeys[0]
  const lastKey = ascendingKeys[ascendingKeys.length - 1]
  if (firstKey === lastKey) return inspectionDateLabelFromKey(firstKey)
  return `${inspectionDateLabelFromKey(firstKey)} - ${inspectionDateLabelFromKey(lastKey)}`
}

function inspectionDateKeysFromOption(optionKey: string) {
  return optionKey.split('|').filter(Boolean)
}

function assetIdInfo(pipe: AmTeamPipe) {
  const upstream = displayValue(pipe.us_mh)
  const downstream = displayValue(pipe.ds_mh)
  if (upstream === '-' && downstream === '-') return '-'
  return `${upstream} to ${downstream}`
}

function inspectionForDate(group: AmTeamPipeInspectionGroup, optionKey: string) {
  if (!optionKey) return group.inspections[0] ?? null
  const dateKeys = new Set(inspectionDateKeysFromOption(optionKey))
  return group.inspections.find((inspection) => dateKeys.has(inspectionDateKey(inspection.inspection_date))) ?? null
}

function filterPipeGroupsByDate(groups: AmTeamPipeInspectionGroup[], optionKey: string) {
  if (!optionKey) return groups
  return groups.filter((group) => inspectionForDate(group, optionKey))
}

function sortPipeGroupsByMli(groups: AmTeamPipeInspectionGroup[], dateKey = '') {
  return [...groups].sort((left, right) => {
    const leftMli = numericValue(inspectionForDate(left, dateKey)?.mli_id)
    const rightMli = numericValue(inspectionForDate(right, dateKey)?.mli_id)
    if (leftMli !== rightMli) return leftMli - rightMli
    return numericValue(left.ml_id) - numericValue(right.ml_id)
  })
}

function sanitizeReportFileName(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function compactCurrentDateKey() {
  const date = new Date()
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('')
}

function reportFileBaseNameFromAddress(address: AmTeamCellValue | undefined) {
  const addressText = displayValue(address)
  const baseName = `${addressText === '-' ? 'CCTV Review' : `${addressText} CCTV Review`}_${compactCurrentDateKey()}`
  return sanitizeReportFileName(baseName).replace(/\s+/g, '_')
}

function reportTitleAddress(address: AmTeamCellValue | undefined) {
  const text = displayValue(address)
  if (text === '-') return 'CCTV Review'
  const suffixes: Record<string, string> = {
    AVE: 'Avenue',
    BLVD: 'Boulevard',
    CIR: 'Circle',
    CT: 'Court',
    DR: 'Drive',
    HWY: 'Highway',
    LN: 'Lane',
    PKWY: 'Parkway',
    PL: 'Place',
    RD: 'Road',
    ST: 'Street',
    TER: 'Terrace',
    WAY: 'Way',
  }

  return text
    .trim()
    .split(/\s+/)
    .map((part) => {
      const cleanPart = part.replace(/[.,]/g, '').toUpperCase()
      if (suffixes[cleanPart]) return suffixes[cleanPart]
      if (/^\d+[A-Z]?$/.test(cleanPart)) return cleanPart
      return cleanPart.charAt(0) + cleanPart.slice(1).toLowerCase()
    })
    .join(' ')
}

function reportAssetId(inspection: AmTeamInspection) {
  const assetId = displayValue(inspection.ml_name)
  if (assetId !== '-') return assetId
  const mlId = displayValue(inspection.ml_id)
  return mlId === '-' ? '-' : `P_${mlId}`
}

function reportFormatFromFileName(fileName: string): ReviewReportFormat {
  return fileName.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx'
}

function reportFileName(baseName: string, format: ReviewReportFormat) {
  const cleanBaseName = sanitizeReportFileName(baseName) || 'CCTV Review Report'
  return `${cleanBaseName}.${format}`
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function pdfEscape(value: string) {
  return value
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ')
}

function blobToImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(blob)
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Snapshot image could not be loaded.'))
    }
    image.src = objectUrl
  })
}

async function blobToReportImage(blob: Blob): Promise<ReportImage> {
  const image = await blobToImage(blob)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  const context = canvas.getContext('2d')
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('Snapshot image could not be rendered.')
  }
  context.drawImage(image, 0, 0)
  const jpegBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) resolve(nextBlob)
      else reject(new Error('Snapshot image could not be converted.'))
    }, 'image/jpeg', 0.88)
  })

  return {
    data: new Uint8Array(await jpegBlob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  }
}

async function fetchReportImage(imageUrl: string): Promise<ReportImage | null> {
  if (!imageUrl) return null
  try {
    const response = await fetch(imageUrl)
    if (!response.ok) return null
    return await blobToReportImage(await response.blob())
  } catch {
    return null
  }
}

async function fetchVideoFrameReportImage(videoUrl: string, timeSeconds: number): Promise<ReportImage | null> {
  if (!videoUrl || !Number.isFinite(timeSeconds)) return null

  return new Promise((resolve) => {
    const video = document.createElement('video')
    let isDone = false
    let targetFrameTime = Math.max(0, timeSeconds)
    let timeoutId = 0

    const finish = (image: ReportImage | null) => {
      if (isDone) return
      isDone = true
      window.clearTimeout(timeoutId)
      video.pause()
      video.removeEventListener('loadedmetadata', seekToFrame)
      video.removeEventListener('loadeddata', captureFrame)
      video.removeEventListener('seeked', captureFrame)
      video.removeEventListener('error', handleError)
      video.removeAttribute('src')
      video.load()
      resolve(image)
    }

    const handleError = () => finish(null)

    const captureFrame = () => {
      if (isDone) return
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return
      if (targetFrameTime > 0 && Math.abs(video.currentTime - targetFrameTime) > 0.2) return

      try {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const context = canvas.getContext('2d')
        if (!context) {
          finish(null)
          return
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          if (!blob) {
            finish(null)
            return
          }
          void blob.arrayBuffer()
            .then((buffer) => finish({
              data: new Uint8Array(buffer),
              width: canvas.width,
              height: canvas.height,
            }))
            .catch(() => finish(null))
        }, 'image/jpeg', 0.88)
      } catch {
        finish(null)
      }
    }

    function seekToFrame() {
      const boundedStart = Math.max(0, timeSeconds)
      const boundedEnd = Number.isFinite(video.duration) && video.duration > 0
        ? Math.max(0, video.duration - 0.05)
        : boundedStart
      const targetTime = Math.min(boundedStart, boundedEnd)
      targetFrameTime = targetTime

      if (targetTime <= 0) {
        if (video.readyState >= 2) captureFrame()
        return
      }

      try {
        video.currentTime = targetTime
      } catch {
        finish(null)
      }
    }

    timeoutId = window.setTimeout(() => finish(null), 16000)
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.addEventListener('loadedmetadata', seekToFrame)
    video.addEventListener('loadeddata', captureFrame)
    video.addEventListener('seeked', captureFrame)
    video.addEventListener('error', handleError)
    video.src = videoUrl
    video.load()
  })
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function appendUint16(bytes: number[], value: number) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff)
}

function appendUint32(bytes: number[], value: number) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

function appendBytes(bytes: number[], value: Uint8Array) {
  for (const byte of value) bytes.push(byte)
}

function createZipBlob(entries: Array<{ name: string; content: Uint8Array }>, mimeType: string) {
  const encoder = new TextEncoder()
  const bytes: number[] = []
  const centralDirectory: number[] = []

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const offset = bytes.length
    const checksum = crc32(entry.content)
    const flags = 0x0800

    appendUint32(bytes, 0x04034b50)
    appendUint16(bytes, 20)
    appendUint16(bytes, flags)
    appendUint16(bytes, 0)
    appendUint16(bytes, 0)
    appendUint16(bytes, 0)
    appendUint32(bytes, checksum)
    appendUint32(bytes, entry.content.length)
    appendUint32(bytes, entry.content.length)
    appendUint16(bytes, nameBytes.length)
    appendUint16(bytes, 0)
    appendBytes(bytes, nameBytes)
    appendBytes(bytes, entry.content)

    appendUint32(centralDirectory, 0x02014b50)
    appendUint16(centralDirectory, 20)
    appendUint16(centralDirectory, 20)
    appendUint16(centralDirectory, flags)
    appendUint16(centralDirectory, 0)
    appendUint16(centralDirectory, 0)
    appendUint16(centralDirectory, 0)
    appendUint32(centralDirectory, checksum)
    appendUint32(centralDirectory, entry.content.length)
    appendUint32(centralDirectory, entry.content.length)
    appendUint16(centralDirectory, nameBytes.length)
    appendUint16(centralDirectory, 0)
    appendUint16(centralDirectory, 0)
    appendUint16(centralDirectory, 0)
    appendUint16(centralDirectory, 0)
    appendUint32(centralDirectory, 0)
    appendUint32(centralDirectory, offset)
    appendBytes(centralDirectory, nameBytes)
  }

  const centralDirectoryOffset = bytes.length
  appendBytes(bytes, new Uint8Array(centralDirectory))
  appendUint32(bytes, 0x06054b50)
  appendUint16(bytes, 0)
  appendUint16(bytes, 0)
  appendUint16(bytes, entries.length)
  appendUint16(bytes, entries.length)
  appendUint32(bytes, centralDirectory.length)
  appendUint32(bytes, centralDirectoryOffset)
  appendUint16(bytes, 0)

  return new Blob([new Uint8Array(bytes)], { type: mimeType })
}

function createDocxReportBlob(report: ReviewReportFile) {
  const encoder = new TextEncoder()
  const imageEntries: Array<{ name: string; content: Uint8Array }> = []
  const imageRelationships: string[] = []
  let imageIndex = 0
  const paragraphs = report.elements.map((element, index) => {
    if (element.type === 'image') {
      imageIndex += 1
      const imageName = `image${imageIndex}.jpg`
      const relationshipId = `rImage${imageIndex}`
      imageEntries.push({ name: `word/media/${imageName}`, content: element.image.data })
      imageRelationships.push(
        `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imageName}"/>`,
      )
      const maxWidth = 610
      const scale = element.image.width > maxWidth ? maxWidth / element.image.width : 1
      const widthEmu = Math.round(element.image.width * scale * 9525)
      const heightEmu = Math.round(element.image.height * scale * 9525)
      return `<w:p><w:r><w:drawing>
        <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
          <wp:docPr id="${imageIndex}" name="Defect snapshot ${imageIndex}"/>
          <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:nvPicPr><pic:cNvPr id="${imageIndex}" name="${imageName}"/><pic:cNvPicPr/></pic:nvPicPr>
                <pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing></w:r></w:p>`
    }

    const escapedText = xmlEscape(element.text || ' ')
    const outlineLevel = typeof element.outlineLevel === 'number' ? Math.max(0, element.outlineLevel - 1) : null
    const paragraphPropertyParts = [
      outlineLevel === null ? '' : `<w:outlineLvl w:val="${outlineLevel}"/>`,
      element.alignment === 'center' ? '<w:jc w:val="center"/>' : '',
    ].filter(Boolean)
    const paragraphProperties = paragraphPropertyParts.length > 0 ? `<w:pPr>${paragraphPropertyParts.join('')}</w:pPr>` : ''
    const isBold = element.bold ?? Boolean(element.heading || index === 0)
    const fontSize = element.fontSize ?? (element.heading || index === 0 ? 16 : null)
    const runPropertyParts = [
      isBold ? '<w:b/>' : '',
      element.underline ? '<w:u w:val="single"/>' : '',
      typeof fontSize === 'number' ? `<w:sz w:val="${Math.round(fontSize * 2)}"/>` : '',
    ].filter(Boolean)
    const runProperties = runPropertyParts.length > 0 ? `<w:rPr>${runPropertyParts.join('')}</w:rPr>` : ''
    return `<w:p>${paragraphProperties}<w:r>${runProperties}<w:t xml:space="preserve">${escapedText}</w:t></w:r></w:p>`
  }).join('')
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${paragraphs}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`

  return createZipBlob([
    {
      name: '[Content_Types].xml',
      content: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
    },
    {
      name: '_rels/.rels',
      content: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    },
    { name: 'word/document.xml', content: encoder.encode(documentXml) },
    {
      name: 'word/_rels/document.xml.rels',
      content: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${imageRelationships.join('\n  ')}
</Relationships>`),
    },
    ...imageEntries,
  ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
}

function createPdfReportBlob(report: ReviewReportFile) {
  type PdfObject = Array<string | Uint8Array>
  type PdfPage = {
    commands: string[]
    xobjects: Array<{ name: string; objectId: number }>
  }

  const objects: PdfObject[] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    [''],
    ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'],
  ]
  const pages: PdfPage[] = []
  const pageWidth = 612
  const pageHeight = 792
  const pageMargin = 72
  let currentPage: PdfPage = { commands: [], xobjects: [] }
  let currentY = pageHeight - pageMargin
  let imageIndex = 0
  const encoder = new TextEncoder()

  const addPage = () => {
    if (currentPage.commands.length > 0 || pages.length === 0) pages.push(currentPage)
    currentPage = { commands: [], xobjects: [] }
    currentY = pageHeight - pageMargin
  }
  const ensureSpace = (height: number) => {
    if (currentY - height < pageMargin) addPage()
  }
  const addText = (element: ReviewReportParagraph) => {
    const text = element.text || ' '
    const fontSize = element.fontSize ?? (element.heading ? 14 : 10)
    const lineHeight = Math.max(fontSize + 4, element.heading ? 18 : 14)
    const fontName = element.bold || element.heading ? 'F2' : 'F1'
    const estimatedTextWidth = text.length * fontSize * 0.52
    const textX = element.alignment === 'center'
      ? Math.max(pageMargin, (pageWidth - estimatedTextWidth) / 2)
      : pageMargin
    ensureSpace(lineHeight)
    currentPage.commands.push(`BT /${fontName} ${fontSize} Tf ${textX} ${currentY} Td (${pdfEscape(text)}) Tj ET`)
    if (element.underline) {
      const underlineWidth = Math.min(pageWidth - (pageMargin * 2), Math.max(16, text.length * fontSize * 0.52))
      currentPage.commands.push(`0.5 w ${textX} ${currentY - 2} m ${textX + underlineWidth} ${currentY - 2} l S`)
    }
    currentY -= lineHeight
  }
  const addImage = (image: ReportImage) => {
    imageIndex += 1
    const maxWidth = pageWidth - (pageMargin * 2)
    const maxHeight = 300
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1)
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    ensureSpace(height + 12)
    const objectId = objects.length + 1
    objects.push([
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>\nstream\n`,
      image.data,
      '\nendstream',
    ])
    const name = `Im${imageIndex}`
    currentPage.xobjects.push({ name, objectId })
    currentPage.commands.push(`q ${width} 0 0 ${height} ${pageMargin} ${currentY - height} cm /${name} Do Q`)
    currentY -= height + 12
  }

  for (const element of report.elements) {
    if (element.type === 'paragraph') addText(element)
    else addImage(element.image)
  }
  addPage()

  const pageObjectIds: number[] = []
  for (const page of pages) {
    const content = page.commands.join('\n')
    const contentId = objects.length + 1
    objects.push([`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`])
    const xobjectResources = page.xobjects.length
      ? `/XObject << ${page.xobjects.map((xobject) => `/${xobject.name} ${xobject.objectId} 0 R`).join(' ')} >>`
      : ''
    const pageId = objects.length + 1
    objects.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> ${xobjectResources} >> /Contents ${contentId} 0 R >>`])
    pageObjectIds.push(pageId)
  }

  objects[1] = [`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`]

  const chunks: Uint8Array[] = []
  let byteLength = 0
  const appendChunk = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    chunks.push(bytes)
    byteLength += bytes.length
  }
  const offsets = [0]
  appendChunk('%PDF-1.4\n')
  objects.forEach((object, index) => {
    offsets.push(byteLength)
    appendChunk(`${index + 1} 0 obj\n`)
    object.forEach(appendChunk)
    appendChunk('\nendobj\n')
  })
  const xrefOffset = byteLength
  appendChunk(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  for (let index = 1; index < offsets.length; index += 1) {
    appendChunk(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`)
  }
  appendChunk(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`)

  return new Blob(
    chunks.map((chunk) => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer),
    { type: 'application/pdf' },
  )
}

function createReviewReportBlob(report: ReviewReportFile, format: ReviewReportFormat) {
  return format === 'pdf' ? createPdfReportBlob(report) : createDocxReportBlob(report)
}

async function saveReviewReportFile(report: ReviewReportFile) {
  const pickerWindow = window as SaveFilePickerWindow
  const suggestedName = reportFileName(report.suggestedBaseName, 'docx')

  if (pickerWindow.showSaveFilePicker) {
    const handle = await pickerWindow.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: 'Word document (*.docx)',
          accept: {
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
          },
        },
        {
          description: 'PDF document (*.pdf)',
          accept: {
            'application/pdf': ['.pdf'],
          },
        },
      ],
      excludeAcceptAllOption: true,
    })
    const format = reportFormatFromFileName(handle.name)
    const writable = await handle.createWritable()
    await writable.write(createReviewReportBlob(report, format))
    await writable.close()
    return
  }

  const fallbackName = window.prompt('Save report as .docx or .pdf', suggestedName)
  if (!fallbackName) return
  const format = reportFormatFromFileName(fallbackName)
  const downloadName = fallbackName.toLowerCase().endsWith(`.${format}`) ? fallbackName : reportFileName(fallbackName, format)
  const link = document.createElement('a')
  link.href = URL.createObjectURL(createReviewReportBlob(report, format))
  link.download = downloadName
  document.body.appendChild(link)
  link.click()
  URL.revokeObjectURL(link.href)
  link.remove()
}

function pipeGradeThreePlusCount(
  pipeId: string,
  groupedObservations: ObservationDistanceGroup[],
  observationDefectSelections: Record<string, ObservationDefectSelection>,
) {
  return groupedObservations.reduce((count, group) => {
    const groupSelection = observationDefectSelections[pipeScopedKey(pipeId, group.key)]
    return distanceGroupHasHighAmScore(groupSelection) ? count + 1 : count
  }, 0)
}

function observationReportText(observation: AmTeamObservation, isExtensive: boolean) {
  const text = displayValue(observation.observation_text)
  return isExtensive && text !== '-' ? `${text} (Extensive)` : text
}

async function buildReviewReportFile({
  visiblePipeGroups,
  selectedInspectionDateKey,
  pipeObservationCache,
  pipeReviewInputs,
  observationDefectSelections,
  snapshotSelections,
  extensiveDefectSelections,
  mediaMode,
}: {
  visiblePipeGroups: AmTeamPipeInspectionGroup[]
  selectedInspectionDateKey: string
  pipeObservationCache: Record<string, PipeObservationCacheEntry>
  pipeReviewInputs: Record<string, PipeReviewInput>
  observationDefectSelections: Record<string, ObservationDefectSelection>
  snapshotSelections: Record<string, string>
  extensiveDefectSelections: Record<string, boolean>
  mediaMode: MediaSourceMode
}): Promise<ReviewReportFile> {
  const firstInspection = visiblePipeGroups
    .map((group) => inspectionForDate(group, selectedInspectionDateKey) ?? group.inspections[0] ?? null)
    .find((inspection): inspection is AmTeamInspection => Boolean(inspection))
  const elements: ReviewReportElement[] = []
  const addParagraph = (
    text = '',
    options: boolean | Omit<ReviewReportParagraph, 'type' | 'text'> = false,
  ) => {
    if (typeof options === 'boolean') {
      elements.push({ type: 'paragraph', text, heading: options })
      return
    }
    elements.push({ type: 'paragraph', text, ...options })
  }
  const reportTitle = `[${reportTitleAddress(firstInspection?.street)}] - CCTV Review`

  addParagraph(reportTitle, { bold: true, fontSize: 16, outlineLevel: 1, alignment: 'center' })
  addParagraph(`Generated: ${new Date().toLocaleString()}`)
  addParagraph('')

  for (const group of visiblePipeGroups) {
    const pipeId = recordId(group.ml_id)
    const cachedPipe = pipeObservationCache[pipeId]
    const inspection = cachedPipe?.inspection ?? inspectionForDate(group, selectedInspectionDateKey) ?? group.inspections[0]
    if (!inspection) continue

    const pipeReviewInput = pipeReviewInputs[pipeId] ?? emptyPipeReviewInput()
    const groupedPipeObservations = observationDistanceGroups(cachedPipe?.observations ?? [])
    const defectsScoredCount = pipeGradeThreePlusCount(pipeId, groupedPipeObservations, observationDefectSelections)
    let defectNumber = 0
    const cloggingComment = pipeReviewInput.comments.trim()

    addParagraph(`Asset ID: ${reportAssetId(inspection)}`, { bold: true, underline: true, fontSize: 12, outlineLevel: 2 })
    addParagraph(`Inspection Direction: ${inspectionReviewDirection(inspection.inspection_direction)}`)
    addParagraph(`Clogging: ${pipeReviewInput.cloggingPercent || '0'}%;${cloggingComment ? ` ${cloggingComment}` : ''}`)
    if (pipeReviewHasClogging(pipeReviewInput)) {
      if (!pipeReviewHasCloggingSnapshot(pipeReviewInput)) {
        throw new Error(`Capture a clogging video frame for Asset ID ${reportAssetId(inspection)} before generating the report.`)
      }
      const cloggingVideo = cachedPipe?.media.videos.find((video) => video.relative_path === pipeReviewInput.cloggingSnapshotVideoPath)
      if (!cloggingVideo) {
        throw new Error(`Inspection video for Asset ID ${reportAssetId(inspection)} was not found.`)
      }
      const cloggingVideoUrl = mediaAssetViewUrl(cloggingVideo, mediaMode, cachedPipe?.media.media_root ?? '')
      const cloggingImage = await fetchVideoFrameReportImage(cloggingVideoUrl, pipeReviewInput.cloggingSnapshotTimeSeconds ?? 0)
      if (!cloggingImage) {
        throw new Error(
          `Unable to capture the clogging video frame for Asset ID ${reportAssetId(inspection)} at ${
            formatMediaTime(pipeReviewInput.cloggingSnapshotTimeSeconds ?? 0)
          }.`,
        )
      }
      elements.push({ type: 'image', image: cloggingImage })
    }

    if (defectsScoredCount === 0) {
      addParagraph('No Defects Scored 3+; Pipe View Only Video ')
      addParagraph('')
      continue
    }

    for (const distanceGroup of groupedPipeObservations) {
      const scopedGroupKey = pipeScopedKey(pipeId, distanceGroup.key)
      const selection = observationDefectSelections[scopedGroupKey] ?? emptyObservationDefectSelection()
      if (!distanceGroupHasHighAmScore(selection)) continue

      const observationEntries: ObservationCardEntry[] = distanceGroup.observations.map((observation, index) => ({
        cardKey: observationCardKey(observation, index),
        observation,
        observationNumber: index + 1,
      }))
      const majorEntry = observationEntries.find((entry) => entry.cardKey === selection.majorKey)
      if (!majorEntry) continue

      defectNumber += 1
      const scopedMajorCardKey = pipeScopedKey(pipeId, majorEntry.cardKey)
      const selectedSnapshotUrl = snapshotSelections[scopedMajorCardKey]
      const majorImageUrl = selectedSnapshotUrl
        || (majorEntry.observation.image_urls[0]
          ? mediaViewUrl(majorEntry.observation.image_urls[0], mediaMode, cachedPipe?.media.media_root ?? '')
          : '')
      const majorImage = await fetchReportImage(majorImageUrl)
      const otherEntries = observationEntries.filter((entry) => selection.otherKeys.includes(entry.cardKey))
      const additionalCodes = otherEntries
        .map((entry) => observationReportText(entry.observation, Boolean(extensiveDefectSelections[pipeScopedKey(pipeId, entry.cardKey)])))
        .filter((text) => text && text !== '-')

      addParagraph('')
      addParagraph(`Defect ${defectNumber}:`, { bold: true, fontSize: 12, outlineLevel: 3 })
      if (majorImage) elements.push({ type: 'image', image: majorImage })
      addParagraph(`Code: ${observationReportText(majorEntry.observation, Boolean(extensiveDefectSelections[scopedMajorCardKey]))}`)
      addParagraph(`Distance: ${displayValue(majorEntry.observation.distance)}`)
      addParagraph(`AM Score: ${selection.amScore || DEFAULT_MAJOR_DEFECT_AM_SCORE}`)
      if (additionalCodes.length > 0) {
        addParagraph(`Additional Code(s): ${additionalCodes.join('; ')}`)
      }
    }

    addParagraph('')
  }

  return {
    title: reportTitle,
    suggestedBaseName: reportFileBaseNameFromAddress(firstInspection?.street),
    elements,
  }
}

function inspectionDateOptionsFromGroups(groups: AmTeamPipeInspectionGroup[]) {
  const uniqueDateKeys = new Set<string>()
  for (const group of groups) {
    for (const inspection of group.inspections) {
      const key = inspectionDateKey(inspection.inspection_date)
      if (key) uniqueDateKeys.add(key)
    }
  }

  const descendingKeys = [...uniqueDateKeys].sort((left, right) => right.localeCompare(left))
  const options: InspectionDateOption[] = []
  let groupKeys: string[] = []
  let newestKey = ''

  for (const dateKey of descendingKeys) {
    if (groupKeys.length === 0) {
      groupKeys = [dateKey]
      newestKey = dateKey
      continue
    }

    const newestTime = inspectionDateTimeFromKey(newestKey)
    const nextTime = inspectionDateTimeFromKey(dateKey)
    const dayDifference = Math.abs(newestTime - nextTime) / DAY_IN_MS
    if (Number.isFinite(dayDifference) && dayDifference <= INSPECTION_GROUP_DAY_WINDOW) {
      groupKeys.push(dateKey)
      continue
    }

    options.push({
      key: groupKeys.join('|'),
      label: inspectionPeriodLabel(groupKeys),
      dateKeys: groupKeys,
    })
    groupKeys = [dateKey]
    newestKey = dateKey
  }

  if (groupKeys.length > 0) {
    options.push({
      key: groupKeys.join('|'),
      label: inspectionPeriodLabel(groupKeys),
      dateKeys: groupKeys,
    })
  }

  return options
}

function fieldList(fields: Array<[string, AmTeamCellValue | undefined]>) {
  return (
    <dl>
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{displayValue(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

function StatusMessage({
  icon,
  message,
  tone = 'neutral',
}: {
  icon: 'loading' | 'error' | 'empty'
  message: string
  tone?: 'neutral' | 'error'
}) {
  return (
    <div className={`amteam-status-message ${tone}`}>
      {icon === 'loading' ? <Loader2 size={20} className="spin" /> : <AlertCircle size={20} />}
      <span>{message}</span>
    </div>
  )
}

function SnapshotImageBox({
  emptyMessage,
  imageUrls,
  mediaMode,
  mediaRoot,
  readOnly = false,
  selectedUrl,
  showCounter = true,
  title = 'Snapshots',
  onSelectedUrlChange,
}: {
  emptyMessage?: string
  imageUrls: string[]
  mediaMode: MediaSourceMode
  mediaRoot: string
  readOnly?: boolean
  selectedUrl?: string
  showCounter?: boolean
  title?: string
  onSelectedUrlChange?: (url: string) => void
}) {
  const [failedUrls, setFailedUrls] = useState<string[]>([])
  const [internalSelectedUrl, setInternalSelectedUrl] = useState<string | null>(null)
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const viewUrls = imageUrls.map((imageUrl) => mediaViewUrl(imageUrl, mediaMode, mediaRoot))
  const viewUrlKey = viewUrls.join('|')
  const visibleUrls = viewUrls.filter((imageUrl) => !failedUrls.includes(imageUrl))
  const currentSelectedUrl = selectedUrl ?? internalSelectedUrl
  const selectedImageUrl = currentSelectedUrl && visibleUrls.includes(currentSelectedUrl) ? currentSelectedUrl : visibleUrls[0]
  const selectedIndex = Math.max(0, visibleUrls.indexOf(selectedImageUrl))
  const canNavigate = visibleUrls.length > 1

  useEffect(() => {
    setFailedUrls([])
    setInternalSelectedUrl(null)
    setIsPickerOpen(false)
  }, [viewUrlKey])

  if (visibleUrls.length === 0) {
    if (!emptyMessage) return null

    return (
      <figure className="amteam-observation-image empty">
        <figcaption>
          <div className="amteam-observation-image-title static">
            <span>
              <Camera size={14} aria-hidden="true" />
              {title}
            </span>
            {showCounter ? <strong>0</strong> : null}
          </div>
        </figcaption>
        <div className="amteam-observation-image-frame">
          <div className="amteam-observation-image-empty">{emptyMessage}</div>
        </div>
      </figure>
    )
  }

  const updateSelectedUrl = (imageUrl: string) => {
    setInternalSelectedUrl(imageUrl)
    onSelectedUrlChange?.(imageUrl)
  }

  const selectRelativeSnapshot = (offset: number) => {
    if (!canNavigate) return
    const nextIndex = (selectedIndex + offset + visibleUrls.length) % visibleUrls.length
    updateSelectedUrl(visibleUrls[nextIndex])
  }

  return (
    <figure className="amteam-observation-image">
      <figcaption>
        {readOnly ? (
          <div className="amteam-observation-image-title static">
            <span>
              <Camera size={14} aria-hidden="true" />
              {title}
            </span>
            {showCounter ? (
              <strong>
                {selectedIndex + 1} / {visibleUrls.length.toLocaleString()}
              </strong>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className="amteam-observation-image-title"
            onClick={() => setIsPickerOpen(true)}
          >
            <span>
              <Camera size={14} aria-hidden="true" />
              {title}
            </span>
            {showCounter ? (
              <strong>
                {selectedIndex + 1} / {visibleUrls.length.toLocaleString()}
              </strong>
            ) : null}
          </button>
        )}
      </figcaption>
      <div className="amteam-observation-image-frame">
        <img
          alt=""
          key={selectedImageUrl}
          loading="lazy"
          src={selectedImageUrl}
          onError={() => setFailedUrls((current) => (
            current.includes(selectedImageUrl) ? current : [...current, selectedImageUrl]
          ))}
        />
        {canNavigate && !readOnly ? (
          <>
            <button
              type="button"
              className="amteam-observation-image-nav previous"
              aria-label="Previous snapshot"
              onClick={() => selectRelativeSnapshot(-1)}
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="amteam-observation-image-nav next"
              aria-label="Next snapshot"
              onClick={() => selectRelativeSnapshot(1)}
            >
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>

      {isPickerOpen && !readOnly ? (
        <div className="amteam-snapshot-picker-backdrop" role="presentation" onClick={() => setIsPickerOpen(false)}>
          <div
            className="amteam-snapshot-picker"
            role="dialog"
            aria-modal="true"
            aria-label="Select snapshot"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <span>
                <Camera size={15} aria-hidden="true" />
                Select Snapshot
              </span>
              <strong>{visibleUrls.length.toLocaleString()}</strong>
              <button type="button" aria-label="Close snapshot picker" onClick={() => setIsPickerOpen(false)}>
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div className="amteam-snapshot-picker-grid">
              {visibleUrls.map((imageUrl, index) => (
                <button
                  type="button"
                  key={imageUrl}
                  className={imageUrl === selectedImageUrl ? 'selected' : ''}
                  aria-label={`Snapshot ${index + 1}`}
                  onClick={() => {
                    updateSelectedUrl(imageUrl)
                    setIsPickerOpen(false)
                  }}
                >
                  <img
                    alt=""
                    loading="lazy"
                    src={imageUrl}
                    onError={() => setFailedUrls((current) => (
                      current.includes(imageUrl) ? current : [...current, imageUrl]
                    ))}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </figure>
  )
}

function ObservationImage({
  mediaMode,
  mediaRoot,
  observation,
  selectedUrl,
  onSelectedUrlChange,
}: {
  mediaMode: MediaSourceMode
  mediaRoot: string
  observation: AmTeamObservation
  selectedUrl?: string
  onSelectedUrlChange?: (url: string) => void
}) {
  const imageUrls = observation.image_urls?.length ? observation.image_urls : observation.image_url ? [observation.image_url] : []
  return (
    <SnapshotImageBox
      imageUrls={imageUrls}
      mediaMode={mediaMode}
      mediaRoot={mediaRoot}
      selectedUrl={selectedUrl}
      onSelectedUrlChange={onSelectedUrlChange}
    />
  )
}

function MajorDefectPreviewCard({
  entry,
  otherEntries,
  selection,
  mediaMode,
  mediaRoot,
  selectedUrl,
  onAmScoreChange,
  onDefectCommentChange,
  onSelectedUrlChange,
}: {
  entry?: ObservationCardEntry
  otherEntries: ObservationCardEntry[]
  selection: ObservationDefectSelection
  mediaMode: MediaSourceMode
  mediaRoot: string
  selectedUrl?: string
  onAmScoreChange: (value: string) => void
  onDefectCommentChange: (value: string) => void
  onSelectedUrlChange: (url: string) => void
}) {
  const observation = entry?.observation
  const hasMajorDefect = Boolean(observation)
  const imageUrls = observation?.image_urls?.length ? observation.image_urls : observation?.image_url ? [observation.image_url] : []

  return (
    <article className="amteam-observation amteam-major-preview-card">
      <div className="amteam-major-preview-content">
        <label className="amteam-preview-control amteam-preview-score-control">
          <span>AM Score</span>
          <input
            type="number"
            min="3"
            max="5"
            step="1"
            inputMode="numeric"
            disabled={!hasMajorDefect}
            value={hasMajorDefect ? selection.amScore || DEFAULT_MAJOR_DEFECT_AM_SCORE : ''}
            onChange={(event) => onAmScoreChange(event.currentTarget.value)}
          />
        </label>

        <label className="amteam-preview-control">
          <span>Defect comment</span>
          <select
            disabled={!hasMajorDefect}
            value={hasMajorDefect ? selection.defectComment : ''}
            onChange={(event) => onDefectCommentChange(event.currentTarget.value)}
          >
            <option value="">Select comment</option>
            {PIPE_REVIEW_COMMENT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {observation || otherEntries.length ? (
          <div className="amteam-preview-defect-list">
            {observation ? (
              <section className="amteam-preview-defect-block major">
                <span>Major defect</span>
                <strong>{displayValue(observation.code)}</strong>
                <p>{displayValue(observation.observation_text)}</p>
              </section>
            ) : null}

            {otherEntries.map((otherEntry) => (
              <section className="amteam-preview-defect-block other" key={otherEntry.cardKey}>
                <span>Other defect</span>
                <strong>{displayValue(otherEntry.observation.code)}</strong>
                <p>{displayValue(otherEntry.observation.observation_text)}</p>
              </section>
            ))}
          </div>
        ) : null}
      </div>

      <SnapshotImageBox
        emptyMessage={hasMajorDefect ? 'No snapshot image found for this Major defect.' : 'Select a Major defect to preview snapshots.'}
        imageUrls={imageUrls}
        mediaMode={mediaMode}
        mediaRoot={mediaRoot}
        readOnly
        selectedUrl={selectedUrl}
        showCounter={false}
        onSelectedUrlChange={onSelectedUrlChange}
      />
    </article>
  )
}

function ReportDownloadButton({
  mediaMode,
  mediaRoot,
  reports,
}: {
  mediaMode: MediaSourceMode
  mediaRoot: string
  reports: AmTeamMediaAsset[]
}) {
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const pdfReports = useMemo(
    () => reports.filter((report) => report.name.toLowerCase().endsWith('.pdf')),
    [reports],
  )

  useEffect(() => {
    setIsPickerOpen(false)
  }, [pdfReports])

  const openReport = (report: AmTeamMediaAsset) => {
    const reportUrl = mediaAssetViewUrl(report, mediaMode, mediaRoot)
    const link = document.createElement('a')
    link.href = reportUrl
    link.download = report.name
    link.target = '_blank'
    link.rel = 'noreferrer'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const handleDownloadClick = () => {
    if (pdfReports.length === 0) return
    if (pdfReports.length === 1) {
      openReport(pdfReports[0])
      return
    }
    setIsPickerOpen((currentValue) => !currentValue)
  }

  return (
    <div className="amteam-report-download">
      <button
        type="button"
        disabled={pdfReports.length === 0}
        title={pdfReports.length === 0 ? 'No Defect Report PDF found' : 'Download Defect Report'}
        aria-label="Download Defect Report"
        aria-expanded={pdfReports.length > 1 ? isPickerOpen : undefined}
        onClick={handleDownloadClick}
      >
        <Download size={15} />
        <span>Defect Report</span>
      </button>

      {isPickerOpen ? (
        <div className="amteam-report-picker">
          <strong>Select report</strong>
          {pdfReports.map((report) => (
            <button
              type="button"
              key={report.relative_path}
              title={report.name}
              onClick={() => {
                openReport(report)
                setIsPickerOpen(false)
              }}
            >
              <FileText size={15} />
              <span>{report.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function InspectionVideoPlayer({
  mediaMode,
  mediaRoot,
  videos,
  seekRequest,
  onFrameChange,
}: {
  mediaMode: MediaSourceMode
  mediaRoot: string
  videos: AmTeamMediaAsset[]
  seekRequest: VideoSeekRequest | null
  onFrameChange: (frame: ActiveVideoFrame | null) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [selectedVideoPath, setSelectedVideoPath] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [pendingSeekRequest, setPendingSeekRequest] = useState<VideoSeekRequest | null>(null)

  const selectedVideo = useMemo(
    () => videos.find((video) => video.relative_path === selectedVideoPath) ?? videos[0] ?? null,
    [selectedVideoPath, videos],
  )
  const selectedVideoUrl = selectedVideo ? mediaAssetViewUrl(selectedVideo, mediaMode, mediaRoot) : ''

  useEffect(() => {
    setSelectedVideoPath((currentPath) => {
      if (videos.some((video) => video.relative_path === currentPath)) return currentPath
      return videos[0]?.relative_path ?? ''
    })
  }, [videos])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    video.load()
    video.playbackRate = playbackRate
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [selectedVideoUrl])

  useEffect(() => {
    if (!seekRequest) return
    if (!videos.some((video) => video.relative_path === seekRequest.videoPath)) return
    setSelectedVideoPath(seekRequest.videoPath)
    setPendingSeekRequest(seekRequest)
  }, [seekRequest, videos])

  useEffect(() => {
    if (!pendingSeekRequest || selectedVideo?.relative_path !== pendingSeekRequest.videoPath) return undefined
    const video = videoRef.current
    if (!video) return undefined

    const seekToRequestedFrame = () => {
      const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.05) : pendingSeekRequest.timeSeconds
      const nextTime = Math.min(Math.max(0, pendingSeekRequest.timeSeconds), maxTime)
      video.pause()
      video.currentTime = nextTime
      setCurrentTime(nextTime)
      setIsPlaying(false)
      setPendingSeekRequest(null)
    }

    if (video.readyState >= 1) {
      seekToRequestedFrame()
      return undefined
    }

    video.addEventListener('loadedmetadata', seekToRequestedFrame, { once: true })
    return () => video.removeEventListener('loadedmetadata', seekToRequestedFrame)
  }, [pendingSeekRequest, selectedVideo?.relative_path])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate
    }
  }, [playbackRate])

  useEffect(() => {
    if (!selectedVideo) {
      onFrameChange(null)
      return
    }
    onFrameChange({
      videoPath: selectedVideo.relative_path,
      videoName: selectedVideo.name,
      timeSeconds: currentTime,
    })
  }, [currentTime, onFrameChange, selectedVideo])

  if (!videos.length || !selectedVideo) return null

  const playVideo = () => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = playbackRate
    void video.play().catch(() => setIsPlaying(false))
  }

  const pauseVideo = () => {
    videoRef.current?.pause()
  }

  const stopVideo = () => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    video.currentTime = 0
    setCurrentTime(0)
    setIsPlaying(false)
  }

  const seekVideo = (nextValue: string) => {
    const nextTime = Number(nextValue)
    if (!Number.isFinite(nextTime)) return
    setCurrentTime(nextTime)
    if (videoRef.current) {
      videoRef.current.currentTime = nextTime
    }
  }

  const changePlaybackRate = (nextValue: string) => {
    const nextRate = Number(nextValue)
    if (!Number.isFinite(nextRate)) return
    setPlaybackRate(nextRate)
  }

  return (
    <section className="amteam-video-player">
      <header>
        <span>Inspection video</span>
        {videos.length > 1 ? (
          <label className="amteam-video-select">
            <select
              aria-label="Video file"
              value={selectedVideo.relative_path}
              onChange={(event) => {
                setSelectedVideoPath(event.currentTarget.value)
                setCurrentTime(0)
                setDuration(0)
              }}
            >
              {videos.map((video) => (
                <option value={video.relative_path} key={video.relative_path}>
                  {video.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <h3>{selectedVideo.name}</h3>
        )}
      </header>

      <video
        className="amteam-video-frame"
        key={selectedVideo.relative_path}
        preload="metadata"
        playsInline
        ref={videoRef}
        src={selectedVideoUrl}
        onEnded={() => setIsPlaying(false)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
      >
        Your browser does not support video playback.
      </video>

      <div className="amteam-video-controls">
        <div className="amteam-video-buttons">
          <button type="button" onClick={playVideo} disabled={isPlaying} title="Play" aria-label="Play">
            <Play size={18} />
          </button>
          <button type="button" onClick={pauseVideo} disabled={!isPlaying} title="Pause" aria-label="Pause">
            <Pause size={18} />
          </button>
          <button type="button" onClick={stopVideo} title="Stop" aria-label="Stop">
            <Square size={17} />
          </button>
        </div>

        <input
          aria-label="Video progress"
          className="amteam-video-progress"
          type="range"
          min="0"
          max={Math.max(duration, currentTime, 0)}
          step="0.1"
          value={Math.min(currentTime, duration || currentTime)}
          disabled={!duration}
          onChange={(event) => seekVideo(event.currentTarget.value)}
        />

        <time className="amteam-video-time">
          {formatMediaTime(currentTime)} / {formatMediaTime(duration)}
        </time>

        <label className="amteam-video-speed">
          <span>Speed</span>
          <select value={playbackRate} onChange={(event) => changePlaybackRate(event.currentTarget.value)}>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={1.25}>1.25x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
          </select>
        </label>
      </div>
    </section>
  )
}

function PipeDefectReviewPanel({
  inspection,
  gradeThreePlusCount,
  reviewInput,
  currentVideoFrame,
  pipePositionLabel,
  hasNextPipe,
  reviewValidationMessage,
  onReviewInputChange,
  onCaptureCloggingFrame,
  onJumpToCloggingFrame,
  onNextPipe,
}: {
  inspection: AmTeamInspection
  gradeThreePlusCount: number
  reviewInput: PipeReviewInput
  currentVideoFrame: ActiveVideoFrame | null
  pipePositionLabel: string
  hasNextPipe: boolean
  reviewValidationMessage: string
  onReviewInputChange: (input: Partial<PipeReviewInput>) => void
  onCaptureCloggingFrame: () => void
  onJumpToCloggingFrame: () => void
  onNextPipe: () => void
}) {
  const updateCloggingPercent = (value: string) => {
    const nextValue = boundedIntegerInputValue(value, 0, 100)
    if (nextValue !== null) {
      onReviewInputChange(Number(nextValue) > 0
        ? { cloggingPercent: nextValue }
        : { cloggingPercent: nextValue, comments: '', cloggingSnapshotTimeSeconds: null, cloggingSnapshotVideoPath: '' })
    }
  }
  const hasClogging = pipeReviewHasClogging(reviewInput)
  const hasCloggingSnapshot = pipeReviewHasCloggingSnapshot(reviewInput)
  const cloggingSnapshotLabel = hasCloggingSnapshot
    ? `Frame ${formatMediaTime(reviewInput.cloggingSnapshotTimeSeconds ?? 0)}`
    : currentVideoFrame
      ? 'Frame required'
      : 'No video available'

  return (
    <section className="amteam-review-panel">
      <header>
        <span>Pipe Defect Review</span>
        <strong>{inspectionReviewDirection(inspection.inspection_direction)}</strong>
      </header>

      <div className="amteam-review-body">
        <div className="amteam-review-grid">
          <label className="amteam-review-field amteam-clogging-percent-field">
            <span>Clogging</span>
            <div className="amteam-review-number">
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={reviewInput.cloggingPercent}
                onChange={(event) => updateCloggingPercent(event.currentTarget.value)}
              />
              <em>%</em>
              <input
                aria-label="Clogging comment"
                className="amteam-clogging-comment-input"
                list="amteam-clogging-comment-options"
                value={reviewInput.comments}
                disabled={!hasClogging}
                placeholder="Select or enter"
                onChange={(event) => onReviewInputChange({ comments: event.currentTarget.value })}
              />
              <datalist id="amteam-clogging-comment-options">
                {PIPE_REVIEW_PANEL_COMMENT_OPTIONS.map((option) => (
                  <option value={option} key={option} />
                ))}
              </datalist>
            </div>
          </label>

          {hasClogging ? (
            <div className={`amteam-clogging-frame ${hasCloggingSnapshot ? 'captured' : 'needs-capture'}`}>
              <button
                type="button"
                className="amteam-clogging-frame-jump"
                disabled={!hasCloggingSnapshot}
                title={hasCloggingSnapshot ? 'Go to this video frame' : undefined}
                onClick={onJumpToCloggingFrame}
              >
                <span>Clogging frame</span>
                <strong>{cloggingSnapshotLabel}</strong>
              </button>
              <button
                type="button"
                className="amteam-clogging-frame-capture"
                disabled={!currentVideoFrame}
                onClick={onCaptureCloggingFrame}
              >
                <Camera size={15} />
                Capture current frame
              </button>
            </div>
          ) : null}

          <label className="amteam-review-field amteam-review-count-field">
            <span>Defects scored 3+</span>
            <input type="number" min="0" value={gradeThreePlusCount} readOnly aria-label="Defects scored 3 plus" />
          </label>
        </div>
        <nav className="amteam-review-nav" aria-label="Pipe review navigation">
          <span>{pipePositionLabel}</span>
          <button type="button" onClick={onNextPipe}>
            {hasNextPipe ? 'Next pipe' : 'Generate report'}
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </nav>
        {reviewValidationMessage ? <p className="amteam-review-validation-message">{reviewValidationMessage}</p> : null}
      </div>
    </section>
  )
}

function InspectionDateSelect({
  options,
  selectedDateKey,
  onSelectDate,
}: {
  options: InspectionDateOption[]
  selectedDateKey: string
  onSelectDate: (dateKey: string) => void
}) {
  return (
    <label className="amteam-inspection-date-select">
      <span>Inspection date</span>
      <select
        value={selectedDateKey}
        onChange={(event) => onSelectDate(event.target.value)}
      >
        {options.map((option) => {
          return (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          )
        })}
      </select>
    </label>
  )
}

function PipeInspectionGroupCard({
  group,
  index,
  isLocked,
  isReviewed,
  selectedPipeId,
  onSelectPipe,
}: {
  group: AmTeamPipeInspectionGroup
  index: number
  isLocked: boolean
  isReviewed: boolean
  selectedPipeId: string
  onSelectPipe: (group: AmTeamPipeInspectionGroup) => void
}) {
  const pipeId = recordId(group.ml_id)
  const isSelectedPipe = selectedPipeId === pipeId
  const cardClasses = [
    'amteam-pipe-card',
    isSelectedPipe ? 'selected' : '',
    isReviewed ? 'reviewed' : '',
    isLocked ? 'locked' : '',
  ].filter(Boolean).join(' ')
  const statusLabel = isSelectedPipe ? 'Current' : isReviewed ? 'Reviewed' : isLocked ? 'Locked' : 'Ready'

  return (
    <article className={cardClasses}>
      <button className="amteam-pipe-summary" type="button" disabled={isLocked} onClick={() => onSelectPipe(group)}>
        <span className="amteam-pipe-nav-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="amteam-pipe-nav-copy">
          <strong>{displayValue(group.ml_name)}</strong>
          <small>{assetIdInfo(group)}</small>
        </span>
        <span className="amteam-pipe-nav-status">{statusLabel}</span>
      </button>
    </article>
  )
}

function pipeSearchCandidates(pipes: AmTeamPipe[]): SearchCandidate[] {
  const candidates: SearchCandidate[] = []
  const seen = new Set<string>()

  for (const pipe of pipes) {
    for (const [kind, value, detail] of [
      ['ProjectTitle', recordId(pipe.project_title), recordId(pipe.street)],
      ['Address', recordId(pipe.street), recordId(pipe.project_title)],
    ] as const) {
      const trimmedValue = value.trim()
      if (!trimmedValue) continue
      const key = `${kind}:${trimmedValue.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        key,
        kind,
        value: trimmedValue,
        detail: detail.trim(),
      })
    }
  }

  return candidates.slice(0, 10)
}

type AMTeamInspectionViewerProps = {
  pageEyebrow?: string
  pageTitle?: string
  pageDescription?: string
  documentLabel?: string
}

export default function AMTeamInspectionViewer({
  pageEyebrow = 'Proactive Team CCTV',
  pageTitle = 'CCTV Review Report Workspace',
  pageDescription = 'Compile pipe inspection details, observation defects, media, and reports for proactive review.',
  documentLabel = 'CCTV Review Report',
}: AMTeamInspectionViewerProps = {}) {
  const summaryStackRef = useRef<HTMLDivElement | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [lastQuery, setLastQuery] = useState('')
  const [candidatePipes, setCandidatePipes] = useState<AmTeamPipe[]>([])
  const [pipeGroups, setPipeGroups] = useState<AmTeamPipeInspectionGroup[]>([])
  const [selectedInspectionDateKey, setSelectedInspectionDateKey] = useState('')
  const [selectedPipeId, setSelectedPipeId] = useState('')
  const [selectedInspection, setSelectedInspection] = useState<AmTeamInspection | null>(null)
  const [observations, setObservations] = useState<AmTeamObservation[]>([])
  const [inspectionMedia, setInspectionMedia] = useState<AmTeamInspectionMedia>(EMPTY_INSPECTION_MEDIA)
  const [candidateStatus, setCandidateStatus] = useState<LoadStatus>('idle')
  const [candidateMessage, setCandidateMessage] = useState('')
  const [candidateOpen, setCandidateOpen] = useState(false)
  const [pipeStatus, setPipeStatus] = useState<LoadStatus>('idle')
  const [observationStatus, setObservationStatus] = useState<LoadStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [summaryStackHeight, setSummaryStackHeight] = useState(0)
  const [observationDefectSelections, setObservationDefectSelections] = useState<Record<string, ObservationDefectSelection>>({})
  const [pipeReviewInputs, setPipeReviewInputs] = useState<Record<string, PipeReviewInput>>({})
  const [pipeObservationCache, setPipeObservationCache] = useState<Record<string, PipeObservationCacheEntry>>({})
  const [reviewedPipeIds, setReviewedPipeIds] = useState<Record<string, boolean>>({})
  const [distanceGroupValidationFailures, setDistanceGroupValidationFailures] = useState<Record<string, boolean>>({})
  const [reviewValidationMessage, setReviewValidationMessage] = useState('')
  const [collapsedDistanceGroups, setCollapsedDistanceGroups] = useState<Record<string, boolean>>({})
  const [snapshotSelections, setSnapshotSelections] = useState<Record<string, string>>({})
  const [extensiveDefectSelections, setExtensiveDefectSelections] = useState<Record<string, boolean>>({})
  const [activeVideoFrame, setActiveVideoFrame] = useState<ActiveVideoFrame | null>(null)
  const [videoSeekRequest, setVideoSeekRequest] = useState<VideoSeekRequest | null>(null)

  function clearInspectionReport() {
    setPipeGroups([])
    setSelectedInspectionDateKey('')
    setSelectedPipeId('')
    setSelectedInspection(null)
    setObservations([])
    setInspectionMedia(EMPTY_INSPECTION_MEDIA)
    setObservationDefectSelections({})
    setPipeReviewInputs({})
    setPipeObservationCache({})
    setReviewedPipeIds({})
    setDistanceGroupValidationFailures({})
    setReviewValidationMessage('')
    setCollapsedDistanceGroups({})
    setSnapshotSelections({})
    setExtensiveDefectSelections({})
    setActiveVideoFrame(null)
    setVideoSeekRequest(null)
    setPipeStatus('idle')
    setObservationStatus('idle')
  }

  function toggleDistanceGroup(groupKey: string) {
    setCollapsedDistanceGroups((currentGroups) => ({
      ...currentGroups,
      [groupKey]: !currentGroups[groupKey],
    }))
  }

  function clearDistanceGroupValidationFailure(groupKey: string) {
    setDistanceGroupValidationFailures((currentFailures) => {
      if (!currentFailures[groupKey]) return currentFailures
      const nextFailures = { ...currentFailures }
      delete nextFailures[groupKey]
      return nextFailures
    })
  }

  function toggleMajorDefect(groupKey: string, cardKey: string) {
    setReviewValidationMessage('')
    clearDistanceGroupValidationFailure(groupKey)
    const pipeId = pipeIdFromScopedKey(groupKey)
    const scopedCardKey = pipeScopedKey(pipeId, cardKey)
    setObservationDefectSelections((currentSelections) => {
      const currentGroupSelection = currentSelections[groupKey] ?? emptyObservationDefectSelection()
      if (currentGroupSelection.majorKey === cardKey) {
        setExtensiveDefectSelections((currentExtensiveSelections) => {
          const nextExtensiveSelections = { ...currentExtensiveSelections }
          delete nextExtensiveSelections[scopedCardKey]
          currentGroupSelection.otherKeys.forEach((otherKey) => delete nextExtensiveSelections[pipeScopedKey(pipeId, otherKey)])
          return nextExtensiveSelections
        })
        return {
          ...currentSelections,
          [groupKey]: emptyObservationDefectSelection(),
        }
      }

      setExtensiveDefectSelections((currentExtensiveSelections) => {
        if (!currentExtensiveSelections[scopedCardKey]) return currentExtensiveSelections
        const nextExtensiveSelections = { ...currentExtensiveSelections }
        delete nextExtensiveSelections[scopedCardKey]
        return nextExtensiveSelections
      })
      return {
        ...currentSelections,
        [groupKey]: {
          majorKey: cardKey,
          otherKeys: currentGroupSelection.otherKeys.filter((otherKey) => otherKey !== cardKey),
          amScore: DEFAULT_MAJOR_DEFECT_AM_SCORE,
          defectComment: currentGroupSelection.defectComment || PIPE_REVIEW_COMMENT_OPTIONS[0],
          noHighScoreConfirmed: false,
        },
      }
    })
  }

  function toggleOtherDefect(groupKey: string, cardKey: string) {
    const pipeId = pipeIdFromScopedKey(groupKey)
    const scopedCardKey = pipeScopedKey(pipeId, cardKey)
    setObservationDefectSelections((currentSelections) => {
      const currentGroupSelection = currentSelections[groupKey] ?? emptyObservationDefectSelection()
      if (!currentGroupSelection.majorKey) return currentSelections
      if (currentGroupSelection.majorKey === cardKey) return currentSelections

      const isSelected = currentGroupSelection.otherKeys.includes(cardKey)
      if (isSelected) {
        setExtensiveDefectSelections((currentExtensiveSelections) => {
          if (!currentExtensiveSelections[scopedCardKey]) return currentExtensiveSelections
          const nextExtensiveSelections = { ...currentExtensiveSelections }
          delete nextExtensiveSelections[scopedCardKey]
          return nextExtensiveSelections
        })
      }
      return {
        ...currentSelections,
        [groupKey]: {
          ...currentGroupSelection,
          otherKeys: isSelected
            ? currentGroupSelection.otherKeys.filter((otherKey) => otherKey !== cardKey)
            : [...currentGroupSelection.otherKeys, cardKey],
        },
      }
    })
  }

  function updateDistanceGroupAmScore(groupKey: string, value: string) {
    const nextValue = boundedIntegerInputValue(value, 3, 5)
    if (nextValue === null) return

    setReviewValidationMessage('')
    clearDistanceGroupValidationFailure(groupKey)
    setObservationDefectSelections((currentSelections) => {
      const currentGroupSelection = currentSelections[groupKey] ?? emptyObservationDefectSelection()
      if (!currentGroupSelection.majorKey) return currentSelections

      return {
        ...currentSelections,
        [groupKey]: {
          ...currentGroupSelection,
          amScore: nextValue === '' ? DEFAULT_MAJOR_DEFECT_AM_SCORE : nextValue,
          noHighScoreConfirmed: false,
        },
      }
    })
  }

  function updateDistanceGroupDefectComment(groupKey: string, value: string) {
    setObservationDefectSelections((currentSelections) => {
      const currentGroupSelection = currentSelections[groupKey] ?? emptyObservationDefectSelection()
      if (!currentGroupSelection.majorKey) return currentSelections

      return {
        ...currentSelections,
        [groupKey]: {
          ...currentGroupSelection,
          defectComment: value,
        },
      }
    })
  }

  function updateObservationSnapshotSelection(cardKey: string, imageUrl: string) {
    setSnapshotSelections((currentSelections) => ({
      ...currentSelections,
      [cardKey]: imageUrl,
    }))
  }

  function updatePipeReviewInput(pipeId: string, input: Partial<PipeReviewInput>) {
    if (!pipeId) return
    setPipeReviewInputs((currentInputs) => ({
      ...currentInputs,
      [pipeId]: {
        ...(currentInputs[pipeId] ?? emptyPipeReviewInput()),
        ...input,
      },
    }))
  }

  function captureCloggingFrame() {
    if (!selectedPipeId || !activeVideoFrame) return
    updatePipeReviewInput(selectedPipeId, {
      cloggingSnapshotTimeSeconds: Number(activeVideoFrame.timeSeconds.toFixed(2)),
      cloggingSnapshotVideoPath: activeVideoFrame.videoPath,
    })
    setReviewValidationMessage('')
  }

  function jumpToCloggingFrame() {
    if (!selectedPipeId) return
    const reviewInput = pipeReviewInputs[selectedPipeId] ?? emptyPipeReviewInput()
    if (!pipeReviewHasCloggingSnapshot(reviewInput)) return
    setVideoSeekRequest({
      id: Date.now(),
      videoPath: reviewInput.cloggingSnapshotVideoPath,
      timeSeconds: reviewInput.cloggingSnapshotTimeSeconds ?? 0,
    })
  }

  function toggleObservationExtensive(cardKey: string) {
    setExtensiveDefectSelections((currentSelections) => ({
      ...currentSelections,
      [cardKey]: !currentSelections[cardKey],
    }))
  }

  function toggleDistanceGroupNoHighScoreConfirmation(groupKey: string) {
    setReviewValidationMessage('')
    clearDistanceGroupValidationFailure(groupKey)
    const pipeId = pipeIdFromScopedKey(groupKey)
    const currentSelection = observationDefectSelections[groupKey] ?? emptyObservationDefectSelection()
    if (!distanceGroupHasHighAmScore(currentSelection) && !currentSelection.noHighScoreConfirmed) {
      setCollapsedDistanceGroups((currentGroups) => ({
        ...currentGroups,
        [groupKey]: !currentGroups[groupKey],
      }))
    }
    setObservationDefectSelections((currentSelections) => {
      const currentGroupSelection = currentSelections[groupKey] ?? emptyObservationDefectSelection()
      if (distanceGroupHasHighAmScore(currentGroupSelection)) return currentSelections
      const nextIsConfirmed = !currentGroupSelection.noHighScoreConfirmed
      if (nextIsConfirmed) {
        setExtensiveDefectSelections((currentExtensiveSelections) => {
          const nextExtensiveSelections = { ...currentExtensiveSelections }
          if (currentGroupSelection.majorKey) delete nextExtensiveSelections[pipeScopedKey(pipeId, currentGroupSelection.majorKey)]
          currentGroupSelection.otherKeys.forEach((otherKey) => delete nextExtensiveSelections[pipeScopedKey(pipeId, otherKey)])
          return nextExtensiveSelections
        })
      }

      return {
        ...currentSelections,
        [groupKey]: nextIsConfirmed
          ? { ...emptyObservationDefectSelection(), noHighScoreConfirmed: true }
          : emptyObservationDefectSelection(),
      }
    })
  }

  function selectPipeDefault(group: AmTeamPipeInspectionGroup) {
    setSelectedPipeId(recordId(group.ml_id))
    setSelectedInspection(inspectionForDate(group, selectedInspectionDateKey) ?? group.inspections[0] ?? null)
  }

  async function selectNextPipe() {
    const currentIndex = visiblePipeGroups.findIndex((group) => recordId(group.ml_id) === selectedPipeId)
    if (currentIndex < 0) return
    const currentPipeReviewInput = pipeReviewInputs[selectedPipeId] ?? emptyPipeReviewInput()
    if (pipeReviewHasClogging(currentPipeReviewInput) && !pipeReviewHasCloggingSnapshot(currentPipeReviewInput)) {
      setReviewValidationMessage(
        inspectionMedia.videos.length
          ? 'Capture the clogging video frame before moving to the next pipe.'
          : 'Clogging percent is greater than 0, but no inspection video is available for the required frame.',
      )
      return
    }
    const missingConfirmationGroups = groupedObservations.filter((group) => {
      const groupSelection = observationDefectSelections[pipeScopedKey(selectedPipeId, group.key)] ?? emptyObservationDefectSelection()
      return !distanceGroupHasHighAmScore(groupSelection) && !groupSelection.noHighScoreConfirmed
    })

    if (missingConfirmationGroups.length > 0) {
      setDistanceGroupValidationFailures(Object.fromEntries(missingConfirmationGroups.map((group) => [pipeScopedKey(selectedPipeId, group.key), true])))
      setCollapsedDistanceGroups((currentGroups) => ({
        ...currentGroups,
        ...Object.fromEntries(missingConfirmationGroups.map((group) => [pipeScopedKey(selectedPipeId, group.key), false])),
      }))
      setReviewValidationMessage(
        `Confirm no AM score greater or equal to 3 for ${missingConfirmationGroups.length.toLocaleString()} distance ${
          missingConfirmationGroups.length === 1 ? 'group' : 'groups'
        } before moving to the next pipe.`,
      )
      return
    }

    setDistanceGroupValidationFailures({})
    setReviewValidationMessage('')
    const nextReviewedPipeIds = selectedPipeId ? { ...reviewedPipeIds, [selectedPipeId]: true } : reviewedPipeIds
    setReviewedPipeIds(nextReviewedPipeIds)
    const nextGroup = visiblePipeGroups[currentIndex + 1]
    if (!nextGroup) {
      const unvalidatedPipeCount = visiblePipeGroups.filter((group) => !nextReviewedPipeIds[recordId(group.ml_id)]).length
      if (unvalidatedPipeCount > 0) {
        setReviewValidationMessage(
          `Validate ${unvalidatedPipeCount.toLocaleString()} remaining ${unvalidatedPipeCount === 1 ? 'pipe' : 'pipes'} before generating the report.`,
        )
        return
      }
      if (!selectedInspection) return
      try {
        await saveReviewReportFile(await buildReviewReportFile({
          visiblePipeGroups,
          selectedInspectionDateKey,
          pipeObservationCache,
          pipeReviewInputs,
          observationDefectSelections,
          snapshotSelections,
          extensiveDefectSelections,
          mediaMode: selectedMediaMode,
        }))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setReviewValidationMessage(error instanceof Error ? error.message : 'Unable to generate report.')
      }
      return
    }
    selectPipeDefault(nextGroup)
  }

  function selectInspectionDate(dateKey: string) {
    setSelectedInspectionDateKey(dateKey)
    const visibleGroups = sortPipeGroupsByMli(filterPipeGroupsByDate(pipeGroups, dateKey), dateKey)
    const nextGroup = visibleGroups.find((group) => recordId(group.ml_id) === selectedPipeId) ?? visibleGroups[0]
    setSelectedPipeId(nextGroup ? recordId(nextGroup.ml_id) : '')
    setSelectedInspection(nextGroup ? inspectionForDate(nextGroup, dateKey) : null)
  }

  async function runPipeGroupSearch(query: string, kind?: SearchCandidate['kind']) {
    const trimmedQuery = query.trim()
    setLastQuery(trimmedQuery)
    clearInspectionReport()
    if (!trimmedQuery) {
      setPipeStatus('idle')
      return
    }

    setPipeStatus('loading')
    setErrorMessage('')
    try {
      const response = await fetchAmTeamPipeGroups(trimmedQuery, kind)
      const dateOptions = inspectionDateOptionsFromGroups(response.rows)
      const nextDateKey = dateOptions[0]?.key ?? ''
      const sortedRows = sortPipeGroupsByMli(response.rows, nextDateKey)
      setPipeGroups(response.rows)
      setSelectedInspectionDateKey(nextDateKey)
      setPipeStatus('ready')
      const firstGroup = sortedRows.find((group) => group.inspections.length > 0) ?? sortedRows[0]
      if (firstGroup) {
        setSelectedPipeId(recordId(firstGroup.ml_id))
        setSelectedInspection(inspectionForDate(firstGroup, nextDateKey) ?? firstGroup.inspections[0] ?? null)
      }
    } catch (error) {
      setPipeGroups([])
      setPipeStatus('error')
      setErrorMessage(error instanceof Error ? error.message : 'Pipe search failed.')
    }
  }

  async function handleSearch(event?: FormEvent) {
    event?.preventDefault()
    setCandidateOpen(false)
    await runPipeGroupSearch(searchTerm)
  }

  function chooseCandidate(candidate: SearchCandidate) {
    setSearchTerm(candidate.value)
    setCandidateOpen(false)
    void runPipeGroupSearch(candidate.value, candidate.kind)
  }

  useEffect(() => {
    const query = searchTerm.trim()
    if (query.length < 2) {
      setCandidatePipes([])
      setCandidateStatus('idle')
      setCandidateMessage('')
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setCandidateStatus('loading')
      setCandidateMessage('')
      fetchAmTeamPipes(query)
        .then((response) => {
          if (cancelled) return
          setCandidatePipes(response.rows)
          setCandidateStatus('ready')
        })
        .catch((error) => {
          if (cancelled) return
          setCandidatePipes([])
          setCandidateStatus('error')
          setCandidateMessage(error instanceof Error ? error.message : 'Candidate lookup failed.')
        })
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchTerm])

  useEffect(() => {
    setActiveVideoFrame(null)
    setVideoSeekRequest(null)
    if (!selectedInspection) {
      setObservations([])
      setInspectionMedia(EMPTY_INSPECTION_MEDIA)
      setObservationStatus('idle')
      return
    }
    const mliId = recordId(selectedInspection.mli_id)
    if (!mliId) return
    let cancelled = false

    setObservationStatus('loading')
    setObservations([])
    setInspectionMedia(EMPTY_INSPECTION_MEDIA)
    setDistanceGroupValidationFailures({})
    setReviewValidationMessage('')
    setCollapsedDistanceGroups({})
    setErrorMessage('')

    fetchAmTeamObservations(mliId)
      .then((response) => {
        if (cancelled) return
        setObservations(response.rows)
        setInspectionMedia(response.media ?? EMPTY_INSPECTION_MEDIA)
        setPipeObservationCache((currentCache) => ({
          ...currentCache,
          [recordId(selectedInspection.ml_id)]: {
            inspection: selectedInspection,
            observations: response.rows,
            media: response.media ?? EMPTY_INSPECTION_MEDIA,
          },
        }))
        setObservationStatus('ready')
      })
      .catch((error) => {
        if (cancelled) return
        setObservations([])
        setInspectionMedia(EMPTY_INSPECTION_MEDIA)
        setObservationStatus('error')
        setErrorMessage(error instanceof Error ? error.message : 'Observation lookup failed.')
      })

    return () => {
      cancelled = true
    }
  }, [selectedInspection])

  useEffect(() => {
    const node = summaryStackRef.current
    if (!node) {
      setSummaryStackHeight(0)
      return undefined
    }

    const updateHeight = () => {
      setSummaryStackHeight(Math.ceil(node.getBoundingClientRect().height))
    }

    updateHeight()
    window.addEventListener('resize', updateHeight)

    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', updateHeight)
    }

    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [selectedInspection, observationStatus, inspectionMedia.videos.length])

  const defectCountLabel = useMemo(() => {
    if (observationStatus !== 'ready') return '-'
    return observations.length.toLocaleString()
  }, [observationStatus, observations.length])
  const inspectionDateOptions = useMemo(
    () => inspectionDateOptionsFromGroups(pipeGroups),
    [pipeGroups],
  )
  const visiblePipeGroups = useMemo(
    () => sortPipeGroupsByMli(filterPipeGroupsByDate(pipeGroups, selectedInspectionDateKey), selectedInspectionDateKey),
    [pipeGroups, selectedInspectionDateKey],
  )
  const selectedPipeIndex = visiblePipeGroups.findIndex((group) => recordId(group.ml_id) === selectedPipeId)
  const hasNextPipe = selectedPipeIndex >= 0 && selectedPipeIndex < visiblePipeGroups.length - 1
  const pipePositionLabel = selectedPipeIndex >= 0
    ? `Pipe ${selectedPipeIndex + 1} of ${visiblePipeGroups.length}`
    : 'No pipe selected'
  const groupedObservations = useMemo(() => observationDistanceGroups(observations), [observations])
  const gradeThreePlusCount = useMemo(
    () => pipeGradeThreePlusCount(selectedPipeId, groupedObservations, observationDefectSelections),
    [groupedObservations, observationDefectSelections, selectedPipeId],
  )
  const totalInspectionCount = useMemo(
    () => visiblePipeGroups.reduce((sum, group) => {
      if (!selectedInspectionDateKey) return sum + group.inspections.length
      const selectedDateKeys = new Set(inspectionDateKeysFromOption(selectedInspectionDateKey))
      return sum + group.inspections.filter((inspection) => selectedDateKeys.has(inspectionDateKey(inspection.inspection_date))).length
    }, 0),
    [selectedInspectionDateKey, visiblePipeGroups],
  )
  const candidates = useMemo(() => pipeSearchCandidates(candidatePipes), [candidatePipes])
  const showCandidateList = candidateOpen && searchTerm.trim().length >= 2
  const selectedMediaMode = useMemo<MediaSourceMode>(() => mediaSourceMode(), [])
  const summaryGridStyle = useMemo(() => {
    if (observationStatus !== 'ready' || inspectionMedia.videos.length === 0 || summaryStackHeight <= 0) return undefined
    return { '--amteam-summary-height': `${summaryStackHeight}px` } as CSSProperties
  }, [inspectionMedia.videos.length, observationStatus, summaryStackHeight])

  return (
    <main className="amteam-page">
      <header className="amteam-header">
        <div className="amteam-title-copy">
          <span>{pageEyebrow}</span>
          <h1>{pageTitle}</h1>
          <p>{pageDescription}</p>
        </div>
      </header>

      <section className="amteam-workspace">
        <aside className="amteam-sidebar">
          <form className="amteam-search" onSubmit={handleSearch}>
            <label htmlFor="amteam-search-input">Search</label>
            <div className="amteam-search-row">
              <Search size={18} />
              <Input
                id="amteam-search-input"
                type="search"
                value={searchTerm}
                placeholder="Address or project title"
                onBlur={() => window.setTimeout(() => setCandidateOpen(false), 120)}
                onChange={(event) => {
                  setSearchTerm(event.target.value)
                  setCandidateOpen(true)
                }}
                onFocus={() => setCandidateOpen(true)}
              />
              <Button type="submit" size="icon" title="Search">
                <Search size={17} />
              </Button>
            </div>
          </form>

          {showCandidateList ? (
            <div className="amteam-candidate-list">
              {candidateStatus === 'loading' ? (
                <div className="amteam-candidate-note">
                  <Loader2 size={16} className="spin" />
                  <span>Finding candidates</span>
                </div>
              ) : null}
              {candidateStatus === 'error' ? (
                <div className="amteam-candidate-note error">
                  <AlertCircle size={16} />
                  <span>{candidateMessage}</span>
                </div>
              ) : null}
              {candidateStatus === 'ready' && candidates.length === 0 ? (
                <div className="amteam-candidate-note">
                  <AlertCircle size={16} />
                  <span>No candidate titles or addresses found</span>
                </div>
              ) : null}
              {candidates.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseCandidate(candidate)}
                >
                  <span>{candidate.kind === 'ProjectTitle' ? 'Project' : 'Address'}</span>
                  <div>
                    <strong>{candidate.value}</strong>
                    {candidate.detail ? <small>{candidate.detail}</small> : null}
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          {inspectionDateOptions.length > 0 ? (
            <section className="amteam-inspection-filter">
              <InspectionDateSelect
                options={inspectionDateOptions}
                selectedDateKey={selectedInspectionDateKey}
                onSelectDate={selectInspectionDate}
              />
            </section>
          ) : null}

          <section className="amteam-panel">
            <div className="amteam-panel-heading">
              <ClipboardList size={18} />
              <h2>Pipes</h2>
              <span>{visiblePipeGroups.length.toLocaleString()}</span>
            </div>

            {pipeStatus === 'idle' ? <StatusMessage icon="empty" message="Enter a project title or address." /> : null}
            {pipeStatus === 'loading' ? <StatusMessage icon="loading" message="Loading pipes and inspections." /> : null}
            {pipeStatus === 'error' ? <StatusMessage icon="error" tone="error" message={errorMessage} /> : null}
            {pipeStatus === 'ready' && visiblePipeGroups.length === 0 ? (
              <StatusMessage icon="empty" message={`No exact pipe matches found for ${lastQuery}.`} />
            ) : null}
            {pipeStatus === 'ready' && visiblePipeGroups.length > 0 ? (
              <div className="amteam-panel-meta">
                {totalInspectionCount.toLocaleString()} inspections across {visiblePipeGroups.length.toLocaleString()}{' '}
                {visiblePipeGroups.length === 1 ? 'pipe' : 'pipes'}
              </div>
            ) : null}

            <div className="amteam-pipe-list">
              {visiblePipeGroups.map((group, index) => {
                const pipeId = recordId(group.ml_id)
                const isReviewed = Boolean(reviewedPipeIds[pipeId])
                const isLocked = visiblePipeGroups
                  .slice(0, index)
                  .some((previousGroup) => !reviewedPipeIds[recordId(previousGroup.ml_id)])

                return (
                  <PipeInspectionGroupCard
                    key={pipeId || `${recordId(group.project_title)}-${index}`}
                    group={group}
                    index={index}
                    isLocked={isLocked}
                    isReviewed={isReviewed}
                    selectedPipeId={selectedPipeId}
                    onSelectPipe={selectPipeDefault}
                  />
                )
              })}
            </div>
          </section>
        </aside>

        <section className="amteam-document-shell">
          <div className="amteam-document">
            <div className="amteam-document-title">
              <div>
                <span>{documentLabel}</span>
                <h2>{selectedInspection ? displayValue(selectedInspection.street) : 'No inspection selected'}</h2>
              </div>
              <div className="amteam-document-stat">
                <strong>{defectCountLabel}</strong>
                <span>Graded defects</span>
              </div>
            </div>

            {selectedInspection ? (
              <section
                className={`amteam-summary-grid ${observationStatus === 'ready' && inspectionMedia.videos.length ? 'with-video' : ''}`}
                style={summaryGridStyle}
              >
                <div className="amteam-summary-stack" ref={summaryStackRef}>
                  {observationStatus === 'ready' ? (
                    <PipeDefectReviewPanel
                      inspection={selectedInspection}
                      gradeThreePlusCount={gradeThreePlusCount}
                      reviewInput={pipeReviewInputs[selectedPipeId] ?? emptyPipeReviewInput()}
                      currentVideoFrame={activeVideoFrame}
                      pipePositionLabel={pipePositionLabel}
                      hasNextPipe={hasNextPipe}
                      reviewValidationMessage={reviewValidationMessage}
                      onReviewInputChange={(input) => updatePipeReviewInput(selectedPipeId, input)}
                      onCaptureCloggingFrame={captureCloggingFrame}
                      onJumpToCloggingFrame={jumpToCloggingFrame}
                      onNextPipe={selectNextPipe}
                    />
                  ) : null}

                  <div className="amteam-summary-card">
                    <div className="amteam-summary-card-header">
                      <h3>Pipe</h3>
                    </div>
                    {fieldList([
                      ['ML ID', selectedInspection.ml_id],
                      ['ML Name', selectedInspection.ml_name],
                      ['Project', selectedInspection.project_title],
                      ['Street', selectedInspection.street],
                      ['US MH', selectedInspection.us_mh],
                      ['DS MH', selectedInspection.ds_mh],
                      ['Material', selectedInspection.material],
                      ['Shape', selectedInspection.pipe_shape],
                      ['Height', selectedInspection.pipe_height],
                    ])}
                  </div>

                  <div className="amteam-summary-card">
                    <div className="amteam-summary-card-header">
                      <h3>Inspection</h3>
                      <ReportDownloadButton
                        mediaMode={selectedMediaMode}
                        mediaRoot={inspectionMedia.media_root}
                        reports={inspectionMedia.reports}
                      />
                    </div>
                    {fieldList([
                      ['MLI ID', selectedInspection.mli_id],
                      ['Date', compactDate(selectedInspection.inspection_date)],
                      ['Operator', selectedInspection.operator],
                      ['Reason', selectedInspection.reason_of_inspection],
                      ['Direction', selectedInspection.inspection_direction],
                      ['Length', selectedInspection.inspection_length],
                      ['Status', selectedInspection.inspection_status],
                      ['Current', selectedInspection.current_status],
                    ])}
                  </div>
                </div>

                {observationStatus === 'ready' ? (
                  <InspectionVideoPlayer
                    mediaMode={selectedMediaMode}
                    mediaRoot={inspectionMedia.media_root}
                    videos={inspectionMedia.videos}
                    seekRequest={videoSeekRequest}
                    onFrameChange={setActiveVideoFrame}
                  />
                ) : null}
              </section>
            ) : (
              <div className="amteam-document-empty">
                <FileText size={34} />
                <strong>Search a project title or address, then select an inspection to start the report.</strong>
              </div>
            )}

            {observationStatus === 'loading' ? <StatusMessage icon="loading" message="Loading defect observations." /> : null}
            {observationStatus === 'error' ? <StatusMessage icon="error" tone="error" message={errorMessage} /> : null}
            {selectedInspection && observationStatus === 'ready' && observations.length === 0 ? (
              <StatusMessage icon="empty" message="No graded defect observations found." />
            ) : null}

            {groupedObservations.length ? (
              <section className="amteam-observation-list">
                {groupedObservations.map((group, groupIndex) => {
                  const previousObservationCount = groupedObservations
                    .slice(0, groupIndex)
                    .reduce((sum, previousGroup) => sum + previousGroup.observations.length, 0)
                  const scopedGroupKey = pipeScopedKey(selectedPipeId, group.key)
                  const groupSelection = observationDefectSelections[scopedGroupKey] ?? emptyObservationDefectSelection()
                  const isGroupCollapsed = Boolean(collapsedDistanceGroups[scopedGroupKey])
                  const observationEntries: ObservationCardEntry[] = group.observations.map((observation, index) => ({
                    cardKey: observationCardKey(observation, index),
                    observation,
                    observationNumber: previousObservationCount + index + 1,
                  }))
                  const majorObservationEntry = observationEntries.find((entry) => entry.cardKey === groupSelection.majorKey)
                  const otherObservationEntries = observationEntries.filter((entry) => groupSelection.otherKeys.includes(entry.cardKey))
                  const distanceGroupAmScore = groupSelection.majorKey ? groupSelection.amScore || DEFAULT_MAJOR_DEFECT_AM_SCORE : ''
                  const hasDistanceGroupHighAmScore = distanceGroupHasHighAmScore(groupSelection)
                  const isNoHighScoreConfirmed = groupSelection.noHighScoreConfirmed
                  const hasDistanceGroupValidationFailure = Boolean(distanceGroupValidationFailures[scopedGroupKey])
                  const distanceConfirmClasses = [
                    'amteam-distance-confirm-button',
                    isNoHighScoreConfirmed ? 'confirmed' : '',
                    hasDistanceGroupValidationFailure ? 'needs-review' : '',
                  ].filter(Boolean).join(' ')

                  return (
                    <section
                      className={[
                        'amteam-observation-distance-group',
                        isGroupCollapsed ? 'collapsed' : '',
                        hasDistanceGroupValidationFailure ? 'needs-review' : '',
                      ].filter(Boolean).join(' ')}
                      key={group.key}
                    >
                      <header>
                        <button
                          type="button"
                          className="amteam-observation-distance-toggle"
                          aria-expanded={!isGroupCollapsed}
                          onClick={() => toggleDistanceGroup(scopedGroupKey)}
                        >
                          {isGroupCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                          <span>Distance</span>
                          <strong>{group.label}</strong>
                          {distanceGroupAmScore ? (
                            <span className="amteam-distance-score-badge">AM Score {distanceGroupAmScore}</span>
                          ) : null}
                        </button>
                        <div className="amteam-observation-distance-actions">
                          <button
                            type="button"
                            className={distanceConfirmClasses}
                            disabled={hasDistanceGroupHighAmScore}
                            onClick={() => toggleDistanceGroupNoHighScoreConfirmation(scopedGroupKey)}
                          >
                            {hasDistanceGroupHighAmScore
                              ? 'AM score greater or equal to 3 selected'
                              : isNoHighScoreConfirmed
                                ? 'No AM score greater or equal to 3 confirmed'
                                : 'Confirm no AM score greater or equal to 3'}
                          </button>
                          <small>
                            {group.observations.length.toLocaleString()} {group.observations.length === 1 ? 'observation' : 'observations'}
                          </small>
                        </div>
                      </header>

                      {!isGroupCollapsed ? (
                        <div className="amteam-observation-distance-cards">
                          <MajorDefectPreviewCard
                            entry={majorObservationEntry}
                            otherEntries={otherObservationEntries}
                            selection={groupSelection}
                            mediaMode={selectedMediaMode}
                            mediaRoot={inspectionMedia.media_root}
                            selectedUrl={majorObservationEntry ? snapshotSelections[pipeScopedKey(selectedPipeId, majorObservationEntry.cardKey)] : undefined}
                            onAmScoreChange={(value) => updateDistanceGroupAmScore(scopedGroupKey, value)}
                            onDefectCommentChange={(value) => updateDistanceGroupDefectComment(scopedGroupKey, value)}
                            onSelectedUrlChange={(imageUrl) => {
                              if (majorObservationEntry) updateObservationSnapshotSelection(pipeScopedKey(selectedPipeId, majorObservationEntry.cardKey), imageUrl)
                            }}
                          />
                        {observationEntries.map(({ observation, cardKey, observationNumber }) => {
                          const scopedCardKey = pipeScopedKey(selectedPipeId, cardKey)
                          const groupHasMajorDefect = Boolean(groupSelection.majorKey)
                          const isMajorDefect = groupSelection.majorKey === cardKey
                          const isOtherDefect = groupSelection.otherKeys.includes(cardKey)
                          const canMarkExtensive = isMajorDefect || isOtherDefect
                          const isExtensiveDefect = canMarkExtensive && Boolean(extensiveDefectSelections[scopedCardKey])
                          const cardClasses = [
                            'amteam-observation',
                            isMajorDefect ? 'major-defect' : '',
                            isOtherDefect ? 'other-defect' : '',
                            isExtensiveDefect ? 'extensive-defect' : '',
                          ].filter(Boolean).join(' ')

                          return (
                            <article className={cardClasses} key={cardKey}>
                              <header>
                                <div>
                                  <span>Observation {observationNumber}</span>
                                  <h3>{displayValue(observation.code)}</h3>
                                </div>
                                <div className="amteam-observation-header-actions">
                                  <strong>Grade {displayValue(observation.grade)}</strong>
                                  <div className="amteam-observation-defect-controls" aria-label={`Observation ${observationNumber} defect role`}>
                                    <label className={isMajorDefect ? 'selected' : ''}>
                                      <input
                                        type="checkbox"
                                        checked={isMajorDefect}
                                        onChange={() => toggleMajorDefect(scopedGroupKey, cardKey)}
                                      />
                                      <span>Major</span>
                                    </label>
                                    <label className={isOtherDefect ? 'selected' : !groupHasMajorDefect || isMajorDefect ? 'disabled' : ''}>
                                      <input
                                        type="checkbox"
                                        checked={isOtherDefect}
                                        disabled={!groupHasMajorDefect || isMajorDefect}
                                        onChange={() => toggleOtherDefect(scopedGroupKey, cardKey)}
                                      />
                                      <span>Other</span>
                                    </label>
                                    <label className={isExtensiveDefect ? 'selected' : 'disabled'}>
                                      <input
                                        type="checkbox"
                                        checked={isExtensiveDefect}
                                        disabled={!canMarkExtensive}
                                        onChange={() => toggleObservationExtensive(scopedCardKey)}
                                      />
                                      <span>Extensive</span>
                                    </label>
                                  </div>
                                </div>
                              </header>

                              <div className="amteam-observation-body">
                                <div className="amteam-observation-copy">
                                  {fieldList([
                                    ['MLO ID', observation.mlo_id],
                                    ['Continuous', observation.continuous],
                                    ['Joint', formatYesNo(observation.joint)],
                                    ['Value percent', formatPercent(observation.value_percent)],
                                    ['Remarks', observation.remarks],
                                    ['Clock from', observation.clock_from],
                                    ['Clock to', observation.clock_to],
                                  ])}
                                  <p>{displayValue(observation.observation_text)}</p>
                                </div>
                                <ObservationImage
                                  mediaMode={selectedMediaMode}
                                  mediaRoot={inspectionMedia.media_root}
                                  observation={observation}
                                  selectedUrl={snapshotSelections[scopedCardKey]}
                                  onSelectedUrlChange={(imageUrl) => updateObservationSnapshotSelection(scopedCardKey, imageUrl)}
                                />
                              </div>
                            </article>
                          )
                        })}
                        </div>
                      ) : null}
                    </section>
                  )
                })}
              </section>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  )
}
