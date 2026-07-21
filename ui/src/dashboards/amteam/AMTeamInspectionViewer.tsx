import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertCircle,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import {
  fetchCctvReviewReportDetail,
  saveCctvReviewReport,
  type CctvReviewReport,
  type CctvReviewReportSavePayload,
  type CctvReviewSavedPipe,
} from '../../management/api'
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
  desktopAPI?: unknown
  __TAURI_INTERNALS__?: unknown
  chrome?: {
    webview?: unknown
  }
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
type ObservationDefectRole = '' | 'major' | 'other'
type ObservationCardEntry = {
  cardKey: string
  observation: AmTeamObservation
  observationNumber: number
}
type ObservationDetailsSelection = {
  observation: AmTeamObservation
}
type PipeDetailsSelection = {
  group: AmTeamPipeInspectionGroup
  orderNumber: number
}
type PipeReviewOption = {
  pipeId: string
  label: string
  disabled: boolean
}
type ReviewNotice = {
  id: number
  message: string
}
type PipeReviewInput = {
  cloggingPercent: string
  comments: string
  cloggingSnapshotTimeSeconds: number | null
  cloggingSnapshotVideoPath: string
}
type CctvReviewSaveContext = {
  reportKey: string
  reportName: string
  bindingType: CctvReviewReport['binding_type']
  bindingText: string
  inspectionDateText: string
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
type DefectColumnKey = 'observation' | 'defect' | 'review' | 'extensive' | 'snapshot'
type PipeObservationCacheEntry = {
  inspection: AmTeamInspection
  observations: AmTeamObservation[]
  media: AmTeamInspectionMedia
}
type SavedCctvReviewState = {
  selectedInspectionDateKey: string
  pipeGroups: AmTeamPipeInspectionGroup[]
  visiblePipeGroups: AmTeamPipeInspectionGroup[]
  pipeObservationCache: Record<string, PipeObservationCacheEntry>
  pipeReviewInputs: Record<string, PipeReviewInput>
  observationDefectSelections: Record<string, ObservationDefectSelection>
  snapshotSelections: Record<string, string>
  extensiveDefectSelections: Record<string, boolean>
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
const VIDEO_DEFECT_MIN_WIDTH = 320
const VIDEO_DEFECT_TABLE_DEFAULT_WIDTH = 650
const VIDEO_DEFECT_TABLE_MIN_WIDTH = 520
const VIDEO_DEFECT_SPLITTER_WIDTH = 12
const DEFECT_COLUMN_KEYS: DefectColumnKey[] = ['observation', 'defect', 'review', 'extensive', 'snapshot']
const DEFAULT_DEFECT_COLUMN_WIDTHS: Record<DefectColumnKey, number> = {
  observation: 109,
  defect: 300,
  review: 120,
  extensive: 75,
  snapshot: 100,
}
const MIN_DEFECT_COLUMN_WIDTHS: Record<DefectColumnKey, number> = {
  observation: 60,
  defect: 200,
  review: 120,
  extensive: 50,
  snapshot: 100,
}
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
  const launchParameters = new URLSearchParams(window.location.search)
  const declaredDesktopClient = launchParameters.get('client')?.trim().toLowerCase() === 'desktop'
    || launchParameters.get('desktop') === '1'
    || launchParameters.get('media_source')?.trim().toLowerCase() === 'p-drive'
  return Boolean(
    navigator.userAgent.toLowerCase().includes(' electron/')
      || electronWindow.process?.versions?.electron
      || electronWindow.process?.type === 'renderer'
      || electronWindow.electronAPI
      || electronWindow.desktopAPI
      || electronWindow.chrome?.webview
      || electronWindow.__TAURI_INTERNALS__
      || declaredDesktopClient,
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

function uniqueMediaUrls(urls: Array<string | null | undefined>) {
  return [...new Set(urls.filter((url): url is string => Boolean(url)))]
}

function mediaAssetViewUrls(asset: AmTeamMediaAsset, mode: MediaSourceMode, mediaRoot: string) {
  return uniqueMediaUrls([
    mediaAssetViewUrl(asset, mode, mediaRoot),
    asset.url,
  ])
}

function mediaViewUrl(url: string, mode: MediaSourceMode, mediaRoot: string) {
  if (mode === 'p-drive') {
    return localMediaUrl(mediaRoot, relativePathFromMediaApiUrl(url)) || url
  }
  return url
}

function mediaViewUrls(url: string, mode: MediaSourceMode, mediaRoot: string) {
  return uniqueMediaUrls([
    mediaViewUrl(url, mode, mediaRoot),
    url,
  ])
}

function fileNameFromMediaUrl(url: string) {
  const relativePath = relativePathFromMediaApiUrl(url)
  const pathText = relativePath || url
  const cleanPath = pathText.split(/[?#]/)[0] ?? ''
  const segments = cleanPath.split(/[\\/]/).filter(Boolean)
  return decodeURIComponent(segments.at(-1) ?? 'Snapshot')
}

function selectedSnapshotFileName(
  observation: AmTeamObservation,
  scopedCardKey: string,
  snapshotSelections: Record<string, string>,
  mediaMode: MediaSourceMode,
  mediaRoot: string,
) {
  const selectedUrl = snapshotSelections[scopedCardKey]
  const imageUrls = observationImageUrls(observation)
  const defaultUrl = imageUrls[0]
    ? mediaViewUrl(imageUrls[0], mediaMode, mediaRoot)
    : ''
  const effectiveUrl = selectedUrl || defaultUrl
  return effectiveUrl ? fileNameFromMediaUrl(effectiveUrl) : null
}

function snapshotDisplayName(url: string) {
  const fileName = fileNameFromMediaUrl(url)
  const withoutExtension = fileName.replace(/\.[^.]+$/, '')
  const withoutAssetPrefix = withoutExtension.replace(/^(?:[PS]_?\d+_?)+/i, '').replace(/^_+/, '')
  if (withoutAssetPrefix) return withoutAssetPrefix
  return withoutExtension
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
  if (/\bfeet\b/i.test(text)) return text.replace(/\bfeet\b/gi, 'ft')
  if (/\bft\b/i.test(text)) return text
  return `${text} ft`
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

function finiteNumberValue(value: AmTeamCellValue | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function numericValue(value: AmTeamCellValue | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function observationSeekSeconds(observation: AmTeamObservation, video: AmTeamMediaAsset | null | undefined) {
  if (!video) return null
  const seconds = finiteNumberValue(observation.digital_time)
  return seconds !== null && seconds >= 0 ? seconds : null
}

function isInteractiveEventTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && Boolean(target.closest('button,input,select,textarea,a,label,[role="button"]'))
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

function observationImageUrls(observation: AmTeamObservation | undefined) {
  if (!observation) return []
  return observation.image_urls?.length ? observation.image_urls : observation.image_url ? [observation.image_url] : []
}

function observationsByRenderedCardKey(observations: AmTeamObservation[]) {
  const keyedObservations = new Map<string, AmTeamObservation>()
  for (const distanceGroup of observationDistanceGroups(observations)) {
    distanceGroup.observations.forEach((observation, index) => {
      keyedObservations.set(observationCardKey(observation, index), observation)
    })
  }
  return keyedObservations
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

function directUrlToImage(imageUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Snapshot image could not be loaded from the P drive.'))
    image.src = imageUrl
  })
}

async function imageToReportImage(image: HTMLImageElement): Promise<ReportImage> {
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

async function blobToReportImage(blob: Blob): Promise<ReportImage> {
  return imageToReportImage(await blobToImage(blob))
}

async function fetchReportImage(imageUrl: string): Promise<ReportImage | null> {
  if (!imageUrl) return null
  try {
    if (imageUrl.toLowerCase().startsWith('file:')) {
      return await imageToReportImage(await directUrlToImage(imageUrl))
    }
    const response = await fetch(imageUrl)
    if (!response.ok) return null
    return await blobToReportImage(await response.blob())
  } catch {
    return null
  }
}

async function fetchReportImageFromCandidates(imageUrls: string[]) {
  for (const imageUrl of uniqueMediaUrls(imageUrls)) {
    const image = await fetchReportImage(imageUrl)
    if (image) return image
  }
  return null
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

async function fetchVideoFrameReportImageFromCandidates(videoUrls: string[], timeSeconds: number) {
  for (const videoUrl of uniqueMediaUrls(videoUrls)) {
    const image = await fetchVideoFrameReportImage(videoUrl, timeSeconds)
    if (image) return image
  }
  return null
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

function downloadReviewReportFile(report: ReviewReportFile, format: ReviewReportFormat = 'docx') {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(createReviewReportBlob(report, format))
  link.download = reportFileName(report.suggestedBaseName, format)
  document.body.appendChild(link)
  link.click()
  URL.revokeObjectURL(link.href)
  link.remove()
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
  const directDownloadReport = { ...report, suggestedBaseName: downloadName.replace(/\.[^.]+$/, '') }
  downloadReviewReportFile(directDownloadReport, format)
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

function sortedPipeGroupsForReport(
  pipeGroups: AmTeamPipeInspectionGroup[],
  selectedInspectionDateKey: string,
  pipeObservationCache: Record<string, PipeObservationCacheEntry>,
  pipeReviewInputs: Record<string, PipeReviewInput>,
  observationDefectSelections: Record<string, ObservationDefectSelection>,
) {
  return [...pipeGroups].sort((leftGroup, rightGroup) => {
    const reportSortInfo = (group: AmTeamPipeInspectionGroup) => {
      const pipeId = recordId(group.ml_id)
      const cachedPipe = pipeObservationCache[pipeId]
      const inspection = cachedPipe?.inspection ?? inspectionForDate(group, selectedInspectionDateKey) ?? group.inspections[0]
      const groupedObservations = observationDistanceGroups(cachedPipe?.observations ?? [])
      const defectsScoredCount = pipeGradeThreePlusCount(pipeId, groupedObservations, observationDefectSelections)
      const cloggingPercent = cloggingPercentNumber(pipeReviewInputs[pipeId] ?? emptyPipeReviewInput())
      const assetId = reportAssetId(inspection).toLowerCase()
      const category = defectsScoredCount > 0 ? 0 : cloggingPercent > 0 ? 1 : 2
      return { assetId, category, defectsScoredCount }
    }

    const left = reportSortInfo(leftGroup)
    const right = reportSortInfo(rightGroup)
    if (left.category !== right.category) return left.category - right.category
    if (left.category === 0 && left.defectsScoredCount !== right.defectsScoredCount) {
      return right.defectsScoredCount - left.defectsScoredCount
    }
    return left.assetId.localeCompare(right.assetId, undefined, { numeric: true, sensitivity: 'base' })
  })
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

  const reportPipeGroups = sortedPipeGroupsForReport(
    visiblePipeGroups,
    selectedInspectionDateKey,
    pipeObservationCache,
    pipeReviewInputs,
    observationDefectSelections,
  )

  for (const group of reportPipeGroups) {
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
      const cloggingVideoUrls = mediaAssetViewUrls(cloggingVideo, mediaMode, cachedPipe?.media.media_root ?? '')
      const cloggingImage = await fetchVideoFrameReportImageFromCandidates(
        cloggingVideoUrls,
        pipeReviewInput.cloggingSnapshotTimeSeconds ?? 0,
      )
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
      const majorImageUrls = observationImageUrls(majorEntry.observation)
      const selectedSnapshotName = selectedSnapshotUrl ? fileNameFromMediaUrl(selectedSnapshotUrl).toLowerCase() : ''
      const selectedApiImageUrl = majorImageUrls.find((imageUrl) => (
        fileNameFromMediaUrl(imageUrl).toLowerCase() === selectedSnapshotName
      )) ?? majorImageUrls[0]
      const majorImageCandidates = selectedApiImageUrl
        ? mediaViewUrls(selectedApiImageUrl, mediaMode, cachedPipe?.media.media_root ?? '')
        : uniqueMediaUrls([selectedSnapshotUrl])
      const majorImage = await fetchReportImageFromCandidates(majorImageCandidates)
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

function dateTokenToInspectionKey(token: string) {
  const match = token.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!match) return ''
  const [, month, day, year] = match
  return `${year}-${month}-${day}`
}

function inspectionOptionKeyFromReportDateText(value: string) {
  return (value.match(/\d{8}/g) ?? [])
    .map(dateTokenToInspectionKey)
    .filter(Boolean)
    .join('|')
}

function selectedSnapshotUrlFromFileName(
  observation: AmTeamObservation | undefined,
  fileName: string | null,
  mode: MediaSourceMode,
  mediaRoot: string,
) {
  if (!observation || !fileName) return ''
  const normalizedFileName = fileName.toLowerCase()
  const matchedImageUrl = observationImageUrls(observation).find((imageUrl) => (
    fileNameFromMediaUrl(mediaViewUrl(imageUrl, mode, mediaRoot)).toLowerCase() === normalizedFileName
  ))
  return matchedImageUrl ? mediaViewUrl(matchedImageUrl, mode, mediaRoot) : ''
}

function savedPipeReviewInput(savedPipe: CctvReviewSavedPipe, media: AmTeamInspectionMedia): PipeReviewInput {
  return {
    cloggingPercent: String(savedPipe.clogging_percent ?? 0),
    comments: savedPipe.clogging_comment ?? '',
    cloggingSnapshotTimeSeconds: savedPipe.clogging_frame_seconds,
    cloggingSnapshotVideoPath: savedPipe.clogging_frame_seconds === null ? '' : media.videos[0]?.relative_path ?? '',
  }
}

async function loadSavedCctvReviewState(report: CctvReviewReport): Promise<SavedCctvReviewState> {
  const detail = await fetchCctvReviewReportDetail(report.id)
  if (!detail.pipes.length) {
    throw new Error('This report does not have saved pipe review data.')
  }

  const mediaMode = mediaSourceMode()
  const selectedInspectionDateKey = inspectionOptionKeyFromReportDateText(report.inspection_date_text)
  const pipeGroupsResponse = await fetchAmTeamPipeGroups(
    report.binding_text,
    report.binding_type === 'project_title' ? 'ProjectTitle' : 'Address',
  )
  const pipeGroupsById = new Map(pipeGroupsResponse.rows.map((group) => [recordId(group.ml_id), group]))
  const visiblePipeGroups: AmTeamPipeInspectionGroup[] = []
  const pipeObservationCache: Record<string, PipeObservationCacheEntry> = {}
  const pipeReviewInputs: Record<string, PipeReviewInput> = {}
  const observationDefectSelections: Record<string, ObservationDefectSelection> = {}
  const snapshotSelections: Record<string, string> = {}
  const extensiveDefectSelections: Record<string, boolean> = {}

  for (const savedPipe of detail.pipes) {
    const pipeId = recordId(savedPipe.ml_id)
    const group = pipeGroupsById.get(pipeId)
    if (!group) continue

    const observationResponse = await fetchAmTeamObservations(savedPipe.mli_id)
    const inspection = group.inspections.find((candidate) => recordId(candidate.mli_id) === savedPipe.mli_id)
      ?? inspectionForDate(group, selectedInspectionDateKey)
      ?? group.inspections[0]
    if (!inspection) continue

    visiblePipeGroups.push(group)
    pipeObservationCache[pipeId] = {
      inspection,
      observations: observationResponse.rows,
      media: observationResponse.media,
    }
    pipeReviewInputs[pipeId] = savedPipeReviewInput(savedPipe, observationResponse.media)

    const observationsByCardKey = observationsByRenderedCardKey(observationResponse.rows)

    for (const savedDistanceGroup of savedPipe.distance_groups) {
      const groupSelection = emptyObservationDefectSelection()
      groupSelection.amScore = savedDistanceGroup.am_score === null ? '' : String(savedDistanceGroup.am_score)
      groupSelection.defectComment = savedDistanceGroup.defect_comment ?? ''
      groupSelection.noHighScoreConfirmed = savedDistanceGroup.no_am_score_ge_3_confirmed

      for (const savedObservation of savedDistanceGroup.observations) {
        const scopedCardKey = pipeScopedKey(pipeId, savedObservation.source_observation_key)
        if (savedObservation.defect_role === 'major') {
          groupSelection.majorKey = savedObservation.source_observation_key
        } else if (savedObservation.defect_role === 'other') {
          groupSelection.otherKeys.push(savedObservation.source_observation_key)
        }

        if (savedObservation.defect_role !== 'none') {
          extensiveDefectSelections[scopedCardKey] = savedObservation.is_extensive
        }

        const selectedSnapshotUrl = selectedSnapshotUrlFromFileName(
          observationsByCardKey.get(savedObservation.source_observation_key),
          savedObservation.selected_picture_file_name,
          mediaMode,
          observationResponse.media.media_root,
        )
        if (selectedSnapshotUrl) {
          snapshotSelections[scopedCardKey] = selectedSnapshotUrl
        }
      }

      observationDefectSelections[pipeScopedKey(pipeId, savedDistanceGroup.distance_key)] = groupSelection
    }
  }

  if (!visiblePipeGroups.length) {
    throw new Error('The saved report pipes could not be matched to current inspection data.')
  }

  return {
    selectedInspectionDateKey,
    pipeGroups: visiblePipeGroups,
    visiblePipeGroups,
    pipeObservationCache,
    pipeReviewInputs,
    observationDefectSelections,
    snapshotSelections,
    extensiveDefectSelections,
  }
}

export async function downloadSavedCctvReviewReport(report: CctvReviewReport) {
  const savedState = await loadSavedCctvReviewState(report)
  const mediaMode = mediaSourceMode()
  const reportFile = await buildReviewReportFile({
    visiblePipeGroups: savedState.visiblePipeGroups,
    selectedInspectionDateKey: savedState.selectedInspectionDateKey,
    pipeObservationCache: savedState.pipeObservationCache,
    pipeReviewInputs: savedState.pipeReviewInputs,
    observationDefectSelections: savedState.observationDefectSelections,
    snapshotSelections: savedState.snapshotSelections,
    extensiveDefectSelections: savedState.extensiveDefectSelections,
    mediaMode,
  })
  downloadReviewReportFile(reportFile, 'docx')
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

function ReportProgressOverlay({ message }: { message: string }) {
  return (
    <div className="amteam-report-progress-overlay" role="status" aria-live="polite" aria-label={message}>
      <div className="amteam-report-progress-panel">
        <Loader2 size={30} className="spin" aria-hidden="true" />
        <strong>Generating report</strong>
        <span>{message}</span>
        <div className="amteam-report-progress-bar" aria-hidden="true">
          <i />
        </div>
      </div>
    </div>
  )
}

function ObservationDetailsDialog({
  selection,
  onClose,
}: {
  selection: ObservationDetailsSelection | null
  onClose: () => void
}) {
  if (!selection) return null

  const { observation } = selection

  return (
    <div className="amteam-observation-detail-backdrop" role="presentation" onClick={onClose}>
      <div
        className="amteam-observation-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`MLO ${displayValue(observation.mlo_id)} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Observation details</span>
            <strong>MLO ID {displayValue(observation.mlo_id)}</strong>
          </div>
          <button type="button" aria-label="Close observation details" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="amteam-observation-detail-dialog-body">
          {fieldList([
            ['MLO ID', observation.mlo_id],
            ['Continuous', observation.continuous],
            ['Joint', formatYesNo(observation.joint)],
            ['Value percent', formatPercent(observation.value_percent)],
            ['Remarks', observation.remarks],
            ['Clock from', observation.clock_from],
            ['Clock to', observation.clock_to],
          ])}
        </div>
      </div>
    </div>
  )
}

function PipeDetailsDialog({
  selection,
  onClose,
}: {
  selection: PipeDetailsSelection | null
  onClose: () => void
}) {
  if (!selection) return null

  const { group, orderNumber } = selection

  return (
    <div className="amteam-observation-detail-backdrop" role="presentation" onClick={onClose}>
      <div
        className="amteam-observation-detail-dialog amteam-info-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Pipe ${String(orderNumber).padStart(2, '0')} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Pipe details</span>
            <strong>{displayValue(group.ml_name)}</strong>
          </div>
          <button type="button" aria-label="Close pipe details" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="amteam-observation-detail-dialog-body">
          {fieldList([
            ['Pipe order', String(orderNumber).padStart(2, '0')],
            ['ML ID', group.ml_id],
            ['ML Name', group.ml_name],
            ['Project', group.project_title],
            ['Street', group.street],
            ['US MH', group.us_mh],
            ['DS MH', group.ds_mh],
            ['Material', group.material],
            ['Shape', group.pipe_shape],
            ['Height', group.pipe_height],
          ])}
        </div>
      </div>
    </div>
  )
}

function InspectionDetailsDialog({
  inspection,
  mediaMode,
  mediaRoot,
  reports,
  onClose,
}: {
  inspection: AmTeamInspection | null
  mediaMode: MediaSourceMode
  mediaRoot: string
  reports: AmTeamMediaAsset[]
  onClose: () => void
}) {
  if (!inspection) return null

  return (
    <div className="amteam-observation-detail-backdrop" role="presentation" onClick={onClose}>
      <div
        className="amteam-observation-detail-dialog amteam-info-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Inspection ${displayValue(inspection.mli_id)} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Inspection details</span>
            <strong>MLI ID {displayValue(inspection.mli_id)}</strong>
          </div>
          <button type="button" aria-label="Close inspection details" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="amteam-observation-detail-dialog-body">
          <div className="amteam-info-dialog-action-row">
            <ReportDownloadButton mediaMode={mediaMode} mediaRoot={mediaRoot} reports={reports} />
          </div>
          {fieldList([
            ['MLI ID', inspection.mli_id],
            ['Date', compactDate(inspection.inspection_date)],
            ['Operator', inspection.operator],
            ['Reason', inspection.reason_of_inspection],
            ['Direction', inspection.inspection_direction],
            ['Length', inspection.inspection_length],
            ['Status', inspection.inspection_status],
            ['Current', inspection.current_status],
          ])}
        </div>
      </div>
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
  onSelectedUrlChange,
}: {
  emptyMessage?: string
  imageUrls: string[]
  mediaMode: MediaSourceMode
  mediaRoot: string
  readOnly?: boolean
  selectedUrl?: string
  onSelectedUrlChange?: (url: string) => void
}) {
  const [failedSourceUrls, setFailedSourceUrls] = useState<string[]>([])
  const [sourceCandidateIndexes, setSourceCandidateIndexes] = useState<Record<string, number>>({})
  const [internalSelectedUrl, setInternalSelectedUrl] = useState<string | null>(null)
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const mediaSources = imageUrls.map((sourceUrl) => ({
    sourceUrl,
    candidates: mediaViewUrls(sourceUrl, mediaMode, mediaRoot),
  }))
  const viewUrlKey = mediaSources.map(({ sourceUrl, candidates }) => `${sourceUrl}:${candidates.join(',')}`).join('|')
  const visibleSources = mediaSources
    .filter(({ sourceUrl }) => !failedSourceUrls.includes(sourceUrl))
    .map((source) => ({
      ...source,
      viewUrl: source.candidates[Math.min(sourceCandidateIndexes[source.sourceUrl] ?? 0, source.candidates.length - 1)] ?? '',
    }))
    .filter(({ viewUrl }) => Boolean(viewUrl))
  const visibleUrls = visibleSources.map(({ viewUrl }) => viewUrl)
  const currentSelectedUrl = selectedUrl ?? internalSelectedUrl
  const selectedSource = currentSelectedUrl
    ? visibleSources.find(({ candidates }) => candidates.includes(currentSelectedUrl))
    : undefined
  const selectedImageUrl = selectedSource?.viewUrl ?? visibleUrls[0]
  const selectedDisplayName = selectedImageUrl ? snapshotDisplayName(selectedImageUrl) : ''
  const selectedSnapshotIndex = selectedImageUrl ? visibleUrls.indexOf(selectedImageUrl) + 1 : 0
  const snapshotCountLabel = `${selectedSnapshotIndex}/${visibleUrls.length}`

  useEffect(() => {
    setFailedSourceUrls([])
    setSourceCandidateIndexes({})
    setInternalSelectedUrl(null)
    setIsPickerOpen(false)
  }, [viewUrlKey])

  if (visibleUrls.length === 0) {
    if (!emptyMessage) return null

    return (
      <span className="amteam-snapshot-link empty">{emptyMessage}</span>
    )
  }

  const updateSelectedUrl = (imageUrl: string) => {
    setInternalSelectedUrl(imageUrl)
    onSelectedUrlChange?.(imageUrl)
  }

  return (
    <div className="amteam-snapshot-selector">
      <button
        type="button"
        className="amteam-snapshot-link"
        disabled={readOnly}
        title={`${selectedDisplayName} (${snapshotCountLabel})`}
        onClick={() => setIsPickerOpen(true)}
      >
        <span>{selectedDisplayName || 'Select snapshot'}</span>
        <span className="amteam-snapshot-count" title="Current snapshot / total snapshots">
          ({snapshotCountLabel})
        </span>
      </button>

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
              {visibleSources.map(({ sourceUrl, candidates, viewUrl: imageUrl }, index) => (
                <button
                  type="button"
                  key={sourceUrl}
                  className={imageUrl === selectedImageUrl ? 'selected' : ''}
                  aria-label={`Snapshot ${index + 1}: ${snapshotDisplayName(imageUrl)}`}
                  title={snapshotDisplayName(imageUrl)}
                  onClick={() => {
                    updateSelectedUrl(imageUrl)
                    setIsPickerOpen(false)
                  }}
                >
                  <img
                    alt=""
                    loading="lazy"
                    src={imageUrl}
                    onError={() => {
                      const currentCandidateIndex = sourceCandidateIndexes[sourceUrl] ?? 0
                      if (currentCandidateIndex + 1 < candidates.length) {
                        setSourceCandidateIndexes((currentIndexes) => ({
                          ...currentIndexes,
                          [sourceUrl]: currentCandidateIndex + 1,
                        }))
                        return
                      }
                      setFailedSourceUrls((current) => (
                        current.includes(sourceUrl) ? current : [...current, sourceUrl]
                      ))
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ObservationImage({
  mediaMode,
  mediaRoot,
  observation,
  readOnly = false,
  selectedUrl,
  onSelectedUrlChange,
}: {
  mediaMode: MediaSourceMode
  mediaRoot: string
  observation: AmTeamObservation
  readOnly?: boolean
  selectedUrl?: string
  onSelectedUrlChange?: (url: string) => void
}) {
  const imageUrls = observationImageUrls(observation)
  return (
    <SnapshotImageBox
      imageUrls={imageUrls}
      mediaMode={mediaMode}
      mediaRoot={mediaRoot}
      readOnly={readOnly}
      selectedUrl={selectedUrl}
      onSelectedUrlChange={onSelectedUrlChange}
    />
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
  const [isUsingApiFallback, setUsingApiFallback] = useState(false)

  const selectedVideo = useMemo(
    () => videos.find((video) => video.relative_path === selectedVideoPath) ?? videos[0] ?? null,
    [selectedVideoPath, videos],
  )
  const selectedVideoUrls = selectedVideo ? mediaAssetViewUrls(selectedVideo, mediaMode, mediaRoot) : []
  const selectedVideoUrl = selectedVideoUrls[isUsingApiFallback ? selectedVideoUrls.length - 1 : 0] ?? ''

  useEffect(() => {
    setSelectedVideoPath((currentPath) => {
      if (videos.some((video) => video.relative_path === currentPath)) return currentPath
      return videos[0]?.relative_path ?? ''
    })
  }, [videos])

  useEffect(() => {
    setUsingApiFallback(false)
  }, [mediaMode, mediaRoot, selectedVideo?.relative_path])

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
        onError={() => {
          if (!isUsingApiFallback && selectedVideoUrls.length > 1) {
            setUsingApiFallback(true)
          }
        }}
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
  pipeOptions,
  selectedPipeId,
  gradeThreePlusCount,
  reviewInput,
  currentVideoFrame,
  pipePositionLabel,
  hasPreviousPipe,
  hasNextPipe,
  onReviewInputChange,
  onCaptureCloggingFrame,
  onJumpToCloggingFrame,
  onPreviousPipe,
  onSelectPipe,
  onShowPipeInfo,
  onNextPipe,
  onGenerateReport,
  canDownloadExport,
  onDownloadExport,
  readOnly = false,
}: {
  inspection: AmTeamInspection
  pipeOptions: PipeReviewOption[]
  selectedPipeId: string
  gradeThreePlusCount: number
  reviewInput: PipeReviewInput
  currentVideoFrame: ActiveVideoFrame | null
  pipePositionLabel: string
  hasPreviousPipe: boolean
  hasNextPipe: boolean
  onReviewInputChange: (input: Partial<PipeReviewInput>) => void
  onCaptureCloggingFrame: () => void
  onJumpToCloggingFrame: () => void
  onPreviousPipe: () => void
  onSelectPipe: (pipeId: string) => void
  onShowPipeInfo: () => void
  onNextPipe: () => void
  onGenerateReport: () => void
  canDownloadExport: boolean
  onDownloadExport: () => void
  readOnly?: boolean
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
  const inspectionDirectionLabel = inspectionReviewDirection(inspection.inspection_direction)
  const assetDirectionLabel = `[${displayValue(inspection.ml_name)}] - ${inspectionDirectionLabel}`

  return (
    <section className="amteam-review-panel">
      <header className="amteam-review-panel-title">
        <div className="amteam-review-pipe-title" title={assetDirectionLabel}>
          <select
            className="amteam-review-pipe-select"
            aria-label="Select pipe"
            value={selectedPipeId}
            onChange={(event) => onSelectPipe(event.currentTarget.value)}
          >
            {pipeOptions.map((option) => (
              <option key={option.pipeId} value={option.pipeId} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="amteam-review-pipe-info-button"
            title="Show pipe details"
            aria-label="Show pipe details"
            disabled={!selectedPipeId}
            onClick={onShowPipeInfo}
          >
            <FileText size={14} aria-hidden="true" />
          </button>
          <strong className="amteam-review-asset-direction">- {inspectionDirectionLabel}</strong>
        </div>
        <span className="amteam-review-address" title={displayValue(inspection.street)}>{displayValue(inspection.street)}</span>
      </header>
      <div className="amteam-review-row">
        <label className="amteam-review-field amteam-review-count-field">
          <span>Defects scored 3+</span>
          <input type="number" min="0" value={gradeThreePlusCount} readOnly aria-label="Defects scored 3 plus" />
        </label>

        <label className="amteam-review-field amteam-clogging-percent-field">
          <span>Clogging</span>
          <div className="amteam-review-number">
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              inputMode="numeric"
              disabled={readOnly}
              value={reviewInput.cloggingPercent}
              onChange={(event) => updateCloggingPercent(event.currentTarget.value)}
            />
            <em>%</em>
            <input
              aria-label="Clogging comment"
              className="amteam-clogging-comment-input"
              list="amteam-clogging-comment-options"
              value={reviewInput.comments}
              disabled={readOnly || !hasClogging}
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
              disabled={readOnly || !currentVideoFrame}
              onClick={onCaptureCloggingFrame}
            >
              <Camera size={15} />
              Capture
            </button>
          </div>
        ) : null}

        <nav className="amteam-review-nav" aria-label="Pipe review navigation">
          <button
            type="button"
            className="secondary"
            disabled={!hasPreviousPipe}
            onClick={onPreviousPipe}
          >
            <ChevronLeft size={15} aria-hidden="true" />
            Previous
          </button>
          <span>{pipePositionLabel}</span>
          <button type="button" disabled={!hasNextPipe} onClick={onNextPipe}>
            Next
            <ChevronRight size={15} aria-hidden="true" />
          </button>
          {!readOnly ? (
            <button type="button" className="report" onClick={onGenerateReport}>
              Generate report
            </button>
          ) : null}
          <button
            type="button"
            className="download-export"
            disabled={!canDownloadExport}
            onClick={onDownloadExport}
          >
            <Download size={15} aria-hidden="true" />
            Download
          </button>
        </nav>
      </div>
    </section>
  )
}

function InspectionDateSelect({
  options,
  selectedDateKey,
  onSelectDate,
  canShowInspectionInfo,
  onShowInspectionInfo,
}: {
  options: InspectionDateOption[]
  selectedDateKey: string
  onSelectDate: (dateKey: string) => void
  canShowInspectionInfo: boolean
  onShowInspectionInfo: () => void
}) {
  return (
    <div className="amteam-inspection-date-select">
      <span>Inspection date</span>
      <div className="amteam-inspection-date-row">
        <select
          aria-label="Inspection date"
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
        <Button
          type="button"
          size="icon"
          title={canShowInspectionInfo ? 'Show inspection details' : 'Select an inspection first'}
          aria-label="Show inspection details"
          disabled={!canShowInspectionInfo}
          onClick={onShowInspectionInfo}
        >
          <FileText size={16} />
        </Button>
      </div>
    </div>
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
  initialSearchTerm?: string
  initialSearchKind?: SearchCandidate['kind']
  initialInspectionDateKey?: string
  hideReviewNavigation?: boolean
  savedReport?: CctvReviewReport
  readOnly?: boolean
  reportSaveContext?: CctvReviewSaveContext
  onReportSaved?: (report: CctvReviewReport) => void
}

export default function AMTeamInspectionViewer({
  initialSearchTerm = '',
  initialSearchKind,
  initialInspectionDateKey = '',
  hideReviewNavigation = false,
  savedReport,
  readOnly = false,
  reportSaveContext,
  onReportSaved,
}: AMTeamInspectionViewerProps = {}) {
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm)
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
  const [isReviewNavigationCollapsed, setReviewNavigationCollapsed] = useState(false)
  const [pipeStatus, setPipeStatus] = useState<LoadStatus>('idle')
  const [observationStatus, setObservationStatus] = useState<LoadStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [observationDefectSelections, setObservationDefectSelections] = useState<Record<string, ObservationDefectSelection>>({})
  const [pipeReviewInputs, setPipeReviewInputs] = useState<Record<string, PipeReviewInput>>({})
  const [pipeObservationCache, setPipeObservationCache] = useState<Record<string, PipeObservationCacheEntry>>({})
  const [reviewedPipeIds, setReviewedPipeIds] = useState<Record<string, boolean>>({})
  const [distanceGroupValidationFailures, setDistanceGroupValidationFailures] = useState<Record<string, boolean>>({})
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null)
  const [generatedReviewReport, setGeneratedReviewReport] = useState<ReviewReportFile | null>(null)
  const [reportProgressMessage, setReportProgressMessage] = useState('')
  const [collapsedDistanceGroups, setCollapsedDistanceGroups] = useState<Record<string, boolean>>({})
  const [snapshotSelections, setSnapshotSelections] = useState<Record<string, string>>({})
  const [extensiveDefectSelections, setExtensiveDefectSelections] = useState<Record<string, boolean>>({})
  const [activeVideoFrame, setActiveVideoFrame] = useState<ActiveVideoFrame | null>(null)
  const [videoSeekRequest, setVideoSeekRequest] = useState<VideoSeekRequest | null>(null)
  const [selectedObservationDetails, setSelectedObservationDetails] = useState<ObservationDetailsSelection | null>(null)
  const [selectedPipeDetails, setSelectedPipeDetails] = useState<PipeDetailsSelection | null>(null)
  const [isInspectionDetailsOpen, setInspectionDetailsOpen] = useState(false)
  const [videoDefectTableWidth, setVideoDefectTableWidth] = useState(VIDEO_DEFECT_TABLE_DEFAULT_WIDTH)
  const [defectColumnWidths, setDefectColumnWidths] = useState<Record<DefectColumnKey, number>>(DEFAULT_DEFECT_COLUMN_WIDTHS)
  const documentRef = useRef<HTMLDivElement | null>(null)
  const reviewNoticeIdRef = useRef(0)
  const initialSearchLoadedRef = useRef(false)

  function showReviewNotice(message: string) {
    reviewNoticeIdRef.current += 1
    setReviewNotice({ id: reviewNoticeIdRef.current, message })
  }

  function clearReviewNotice() {
    setReviewNotice(null)
  }

  function clearGeneratedReviewReport() {
    setGeneratedReviewReport(null)
  }

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
    clearReviewNotice()
    clearGeneratedReviewReport()
    setCollapsedDistanceGroups({})
    setSnapshotSelections({})
    setExtensiveDefectSelections({})
    setActiveVideoFrame(null)
    setVideoSeekRequest(null)
    setSelectedObservationDetails(null)
    setSelectedPipeDetails(null)
    setInspectionDetailsOpen(false)
    setPipeStatus('idle')
    setObservationStatus('idle')
  }

  useEffect(() => {
    if (!reviewNotice) return undefined
    const timeoutId = window.setTimeout(() => {
      setReviewNotice((currentNotice) => currentNotice?.id === reviewNotice.id ? null : currentNotice)
    }, 3000)
    return () => window.clearTimeout(timeoutId)
  }, [reviewNotice])

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

  function updateObservationDefectRole(groupKey: string, cardKey: string, role: ObservationDefectRole) {
    if (readOnly) return
    clearReviewNotice()
    clearGeneratedReviewReport()
    clearDistanceGroupValidationFailure(groupKey)
    const pipeId = pipeIdFromScopedKey(groupKey)
    const scopedCardKey = pipeScopedKey(pipeId, cardKey)

    setObservationDefectSelections((currentSelections) => {
      const currentGroupSelection = currentSelections[groupKey] ?? emptyObservationDefectSelection()

      if (role === 'major') {
        if (currentGroupSelection.majorKey === cardKey) return currentSelections

        const previousMajorKey = currentGroupSelection.majorKey
        setExtensiveDefectSelections((currentExtensiveSelections) => {
          if (!previousMajorKey) return currentExtensiveSelections
          const nextExtensiveSelections = { ...currentExtensiveSelections }
          delete nextExtensiveSelections[pipeScopedKey(pipeId, previousMajorKey)]
          return nextExtensiveSelections
        })

        return {
          ...currentSelections,
          [groupKey]: {
            majorKey: cardKey,
            otherKeys: currentGroupSelection.otherKeys.filter((otherKey) => otherKey !== cardKey),
            amScore: currentGroupSelection.amScore || DEFAULT_MAJOR_DEFECT_AM_SCORE,
            defectComment: currentGroupSelection.defectComment || PIPE_REVIEW_COMMENT_OPTIONS[0],
            noHighScoreConfirmed: false,
          },
        }
      }

      if (role === 'other') {
        if (!currentGroupSelection.majorKey || currentGroupSelection.majorKey === cardKey) return currentSelections
        if (currentGroupSelection.otherKeys.includes(cardKey)) return currentSelections

        return {
          ...currentSelections,
          [groupKey]: {
            ...currentGroupSelection,
            otherKeys: [...currentGroupSelection.otherKeys, cardKey],
            noHighScoreConfirmed: false,
          },
        }
      }

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

      if (currentGroupSelection.otherKeys.includes(cardKey)) {
        setExtensiveDefectSelections((currentExtensiveSelections) => {
          if (!currentExtensiveSelections[scopedCardKey]) return currentExtensiveSelections
          const nextExtensiveSelections = { ...currentExtensiveSelections }
          delete nextExtensiveSelections[scopedCardKey]
          return nextExtensiveSelections
        })

        return {
          ...currentSelections,
          [groupKey]: {
            ...currentGroupSelection,
            otherKeys: currentGroupSelection.otherKeys.filter((otherKey) => otherKey !== cardKey),
          },
        }
      }

      return currentSelections
    })
  }

  function updateDistanceGroupAmScore(groupKey: string, value: string) {
    if (readOnly) return
    const nextValue = boundedIntegerInputValue(value, 3, 5)
    if (nextValue === null) return

    clearReviewNotice()
    clearGeneratedReviewReport()
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
    if (readOnly) return
    clearGeneratedReviewReport()
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
    if (readOnly) return
    clearGeneratedReviewReport()
    setSnapshotSelections((currentSelections) => ({
      ...currentSelections,
      [cardKey]: imageUrl,
    }))
  }

  function updatePipeReviewInput(pipeId: string, input: Partial<PipeReviewInput>) {
    if (readOnly) return
    if (!pipeId) return
    clearGeneratedReviewReport()
    setPipeReviewInputs((currentInputs) => ({
      ...currentInputs,
      [pipeId]: {
        ...(currentInputs[pipeId] ?? emptyPipeReviewInput()),
        ...input,
      },
    }))
  }

  function captureCloggingFrame() {
    if (readOnly) return
    if (!selectedPipeId || !activeVideoFrame) return
    updatePipeReviewInput(selectedPipeId, {
      cloggingSnapshotTimeSeconds: Number(activeVideoFrame.timeSeconds.toFixed(2)),
      cloggingSnapshotVideoPath: activeVideoFrame.videoPath,
    })
    clearReviewNotice()
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

  function selectedVideoForObservationJump() {
    const currentVideo = activeVideoFrame
      ? inspectionMedia.videos.find((video) => video.relative_path === activeVideoFrame.videoPath)
      : null
    return currentVideo ?? inspectionMedia.videos[0] ?? null
  }

  function jumpToObservationFrame(observation: AmTeamObservation) {
    const video = selectedVideoForObservationJump()
    const seekSeconds = observationSeekSeconds(observation, video)
    if (!video || seekSeconds === null) return
    setVideoSeekRequest({
      id: Date.now(),
      videoPath: video.relative_path,
      timeSeconds: seekSeconds,
    })
  }

  function toggleObservationExtensive(cardKey: string) {
    if (readOnly) return
    clearGeneratedReviewReport()
    setExtensiveDefectSelections((currentSelections) => ({
      ...currentSelections,
      [cardKey]: !currentSelections[cardKey],
    }))
  }

  function toggleDistanceGroupNoHighScoreConfirmation(groupKey: string) {
    if (readOnly) return
    clearReviewNotice()
    clearGeneratedReviewReport()
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
    setSelectedObservationDetails(null)
    setSelectedPipeId(recordId(group.ml_id))
    setSelectedInspection(inspectionForDate(group, selectedInspectionDateKey) ?? group.inspections[0] ?? null)
  }

  function selectPipeById(pipeId: string) {
    const group = visiblePipeGroups.find((pipeGroup) => recordId(pipeGroup.ml_id) === pipeId)
    if (!group) return
    setDistanceGroupValidationFailures({})
    clearReviewNotice()
    selectPipeDefault(group)
  }

  function showSelectedPipeInfo() {
    const group = visiblePipeGroups.find((pipeGroup) => recordId(pipeGroup.ml_id) === selectedPipeId)
    if (!group || selectedPipeIndex < 0) return
    setSelectedPipeDetails({ group, orderNumber: selectedPipeIndex + 1 })
  }

  function selectPreviousPipe() {
    const currentIndex = visiblePipeGroups.findIndex((group) => recordId(group.ml_id) === selectedPipeId)
    if (currentIndex <= 0) return
    setDistanceGroupValidationFailures({})
    clearReviewNotice()
    selectPipeDefault(visiblePipeGroups[currentIndex - 1])
  }

  function validateAndMarkCurrentPipeReviewed(blockedActionLabel = 'moving to the next pipe') {
    const currentIndex = visiblePipeGroups.findIndex((group) => recordId(group.ml_id) === selectedPipeId)
    if (currentIndex < 0) return null
    const currentPipeReviewInput = pipeReviewInputs[selectedPipeId] ?? emptyPipeReviewInput()
    if (pipeReviewHasClogging(currentPipeReviewInput) && !pipeReviewHasCloggingSnapshot(currentPipeReviewInput)) {
      showReviewNotice(
        inspectionMedia.videos.length
          ? `Capture the clogging video frame before ${blockedActionLabel}.`
          : 'Clogging percent is greater than 0, but no inspection video is available for the required frame.',
      )
      return null
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
      showReviewNotice(
        `Confirm no AM score greater or equal to 3 for ${missingConfirmationGroups.length.toLocaleString()} distance ${
          missingConfirmationGroups.length === 1 ? 'group' : 'groups'
        } before ${blockedActionLabel}.`,
      )
      return null
    }

    setDistanceGroupValidationFailures({})
    clearReviewNotice()
    const nextReviewedPipeIds = selectedPipeId ? { ...reviewedPipeIds, [selectedPipeId]: true } : reviewedPipeIds
    setReviewedPipeIds(nextReviewedPipeIds)
    return { currentIndex, reviewedPipeIds: nextReviewedPipeIds }
  }

  function selectNextPipe() {
    if (readOnly) {
      const currentIndex = visiblePipeGroups.findIndex((group) => recordId(group.ml_id) === selectedPipeId)
      const nextGroup = visiblePipeGroups[currentIndex + 1]
      if (nextGroup) selectPipeDefault(nextGroup)
      return
    }
    const validation = validateAndMarkCurrentPipeReviewed()
    if (!validation) return
    const nextGroup = visiblePipeGroups[validation.currentIndex + 1]
    if (!nextGroup) return
    selectPipeDefault(nextGroup)
  }

  function buildCctvReviewReportSavePayload(memo: string | null): CctvReviewReportSavePayload | null {
    if (!reportSaveContext) return null

    return {
      report_key: reportSaveContext.reportKey,
      report_name: reportSaveContext.reportName,
      binding_type: reportSaveContext.bindingType,
      binding_text: reportSaveContext.bindingText,
      inspection_date_text: reportSaveContext.inspectionDateText,
      memo,
      pipes: visiblePipeGroups.map((group) => {
        const pipeId = recordId(group.ml_id)
        const cachedPipe = pipeObservationCache[pipeId]
        const inspection = cachedPipe?.inspection ?? inspectionForDate(group, selectedInspectionDateKey) ?? group.inspections[0] ?? null
        const pipeReviewInput = pipeReviewInputs[pipeId] ?? emptyPipeReviewInput()
        const mediaRoot = cachedPipe?.media.media_root ?? (pipeId === selectedPipeId ? inspectionMedia.media_root : '')
        const pipeObservations = cachedPipe?.observations ?? (pipeId === selectedPipeId ? observations : [])

        return {
          ml_id: pipeId,
          mli_id: recordId(inspection?.mli_id),
          clogging_percent: Math.max(0, Math.round(cloggingPercentNumber(pipeReviewInput))),
          clogging_comment: pipeReviewInput.comments.trim() || null,
          clogging_frame_seconds: pipeReviewInput.cloggingSnapshotTimeSeconds,
          distance_groups: observationDistanceGroups(pipeObservations).map((distanceGroup) => {
            const scopedGroupKey = pipeScopedKey(pipeId, distanceGroup.key)
            const selection = observationDefectSelections[scopedGroupKey] ?? emptyObservationDefectSelection()
            const hasMajorDefect = Boolean(selection.majorKey)

            return {
              distance_key: distanceGroup.key,
              distance_feet: Number.isFinite(distanceGroup.sortValue) ? distanceGroup.sortValue : finiteNumberValue(distanceGroup.observations[0]?.distance),
              am_score: hasMajorDefect ? Number(selection.amScore || DEFAULT_MAJOR_DEFECT_AM_SCORE) : null,
              defect_comment: hasMajorDefect && selection.defectComment.trim() ? selection.defectComment.trim() : null,
              no_am_score_ge_3_confirmed: selection.noHighScoreConfirmed,
              observations: distanceGroup.observations.map((observation, index) => {
                const cardKey = observationCardKey(observation, index)
                const scopedCardKey = pipeScopedKey(pipeId, cardKey)
                const defectRole: 'none' | 'major' | 'other' = selection.majorKey === cardKey
                  ? 'major'
                  : selection.otherKeys.includes(cardKey)
                    ? 'other'
                    : 'none'

                return {
                  mlo_id: recordId(observation.mlo_id) || null,
                  source_observation_key: cardKey,
                  defect_role: defectRole,
                  is_extensive: defectRole !== 'none' && Boolean(extensiveDefectSelections[scopedCardKey]),
                  selected_picture_file_name: selectedSnapshotFileName(
                    observation,
                    scopedCardKey,
                    snapshotSelections,
                    selectedMediaMode,
                    mediaRoot,
                  ),
                }
              }),
            }
          }),
        }
      }),
    }
  }

  async function generateReviewReport() {
    if (readOnly) return
    const validation = validateAndMarkCurrentPipeReviewed('generating the report')
    if (!validation) return
    const unvalidatedPipeCount = visiblePipeGroups.filter((group) => !validation.reviewedPipeIds[recordId(group.ml_id)]).length
    if (unvalidatedPipeCount > 0) {
      showReviewNotice(
        `Validate ${unvalidatedPipeCount.toLocaleString()} remaining ${unvalidatedPipeCount === 1 ? 'pipe' : 'pipes'} before generating the report.`,
      )
      return
    }
    if (!selectedInspection) return
    const memo = reportSaveContext ? window.prompt('Memo for this generated report (optional)', '') : ''
    if (reportSaveContext && memo === null) return
    setReportProgressMessage(reportSaveContext ? 'Saving report data.' : 'Generating report file.')
    try {
      const savePayload = buildCctvReviewReportSavePayload(memo)
      if (savePayload) {
        const saveResponse = await saveCctvReviewReport(savePayload)
        onReportSaved?.(saveResponse.report)
      }
      setReportProgressMessage('Generating report file.')
      const report = await buildReviewReportFile({
        visiblePipeGroups,
        selectedInspectionDateKey,
        pipeObservationCache,
        pipeReviewInputs,
        observationDefectSelections,
        snapshotSelections,
        extensiveDefectSelections,
        mediaMode: selectedMediaMode,
      })
      setGeneratedReviewReport(report)
      setReportProgressMessage('Starting report download.')
      await saveReviewReportFile(report)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      showReviewNotice(error instanceof Error ? error.message : 'Unable to generate report.')
    } finally {
      setReportProgressMessage('')
    }
  }

  async function downloadGeneratedReviewExport() {
    setReportProgressMessage('Preparing report download.')
    try {
      let reportFile = generatedReviewReport
      if (!reportFile && readOnly) {
        reportFile = await buildReviewReportFile({
          visiblePipeGroups,
          selectedInspectionDateKey,
          pipeObservationCache,
          pipeReviewInputs,
          observationDefectSelections,
          snapshotSelections,
          extensiveDefectSelections,
          mediaMode: selectedMediaMode,
        })
        setGeneratedReviewReport(reportFile)
      }
      if (!reportFile) return
      await saveReviewReportFile(reportFile)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      showReviewNotice(error instanceof Error ? error.message : 'Unable to download export.')
    } finally {
      setReportProgressMessage('')
    }
  }

  function selectInspectionDate(dateKey: string) {
    setSelectedObservationDetails(null)
    clearGeneratedReviewReport()
    setSelectedInspectionDateKey(dateKey)
    const visibleGroups = sortPipeGroupsByMli(filterPipeGroupsByDate(pipeGroups, dateKey), dateKey)
    const nextGroup = visibleGroups.find((group) => recordId(group.ml_id) === selectedPipeId) ?? visibleGroups[0]
    setSelectedPipeId(nextGroup ? recordId(nextGroup.ml_id) : '')
    setSelectedInspection(nextGroup ? inspectionForDate(nextGroup, dateKey) : null)
  }

  async function runPipeGroupSearch(query: string, kind?: SearchCandidate['kind'], preferredDateKey = '') {
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
      const nextDateKey = preferredDateKey && dateOptions.some((option) => option.key === preferredDateKey)
        ? preferredDateKey
        : dateOptions[0]?.key ?? ''
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

  useEffect(() => {
    if (!savedReport) return undefined

    let cancelled = false
    initialSearchLoadedRef.current = true
    setSearchTerm(savedReport.binding_text)
    setLastQuery(savedReport.binding_text)
    clearInspectionReport()
    setPipeStatus('loading')
    setErrorMessage('')
    setReportProgressMessage('Loading saved report.')

    loadSavedCctvReviewState(savedReport)
      .then((savedState) => {
        if (cancelled) return
        const firstGroup = savedState.visiblePipeGroups[0]
        const firstPipeId = firstGroup ? recordId(firstGroup.ml_id) : ''
        const firstCachedPipe = firstPipeId ? savedState.pipeObservationCache[firstPipeId] : null

        setPipeGroups(savedState.pipeGroups)
        setSelectedInspectionDateKey(savedState.selectedInspectionDateKey)
        setSelectedPipeId(firstPipeId)
        setSelectedInspection(firstCachedPipe?.inspection ?? null)
        setObservations(firstCachedPipe?.observations ?? [])
        setInspectionMedia(firstCachedPipe?.media ?? EMPTY_INSPECTION_MEDIA)
        setPipeObservationCache(savedState.pipeObservationCache)
        setPipeReviewInputs(savedState.pipeReviewInputs)
        setObservationDefectSelections(savedState.observationDefectSelections)
        setSnapshotSelections(savedState.snapshotSelections)
        setExtensiveDefectSelections(savedState.extensiveDefectSelections)
        setReviewedPipeIds(Object.fromEntries(savedState.visiblePipeGroups.map((group) => [recordId(group.ml_id), true])))
        setCollapsedDistanceGroups({})
        setDistanceGroupValidationFailures({})
        setGeneratedReviewReport(null)
        setPipeStatus('ready')
        setObservationStatus(firstCachedPipe ? 'ready' : 'idle')
      })
      .catch((error) => {
        if (cancelled) return
        setPipeGroups([])
        setSelectedInspection(null)
        setPipeStatus('error')
        setObservationStatus('idle')
        setErrorMessage(error instanceof Error ? error.message : 'Saved report lookup failed.')
      })
      .finally(() => {
        if (!cancelled) setReportProgressMessage('')
      })

    return () => {
      cancelled = true
    }
  }, [savedReport?.id])

  useEffect(() => {
    if (savedReport) return
    if (initialSearchLoadedRef.current || !initialSearchTerm.trim()) return
    initialSearchLoadedRef.current = true
    setSearchTerm(initialSearchTerm)
    void runPipeGroupSearch(initialSearchTerm, initialSearchKind, initialInspectionDateKey)
  }, [initialInspectionDateKey, initialSearchKind, initialSearchTerm, savedReport])

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
    clearReviewNotice()
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

  const inspectionDateOptions = useMemo(
    () => inspectionDateOptionsFromGroups(pipeGroups),
    [pipeGroups],
  )
  const visiblePipeGroups = useMemo(
    () => sortPipeGroupsByMli(filterPipeGroupsByDate(pipeGroups, selectedInspectionDateKey), selectedInspectionDateKey),
    [pipeGroups, selectedInspectionDateKey],
  )
  const selectedPipeIndex = visiblePipeGroups.findIndex((group) => recordId(group.ml_id) === selectedPipeId)
  const hasPreviousPipe = selectedPipeIndex > 0
  const hasNextPipe = selectedPipeIndex >= 0 && selectedPipeIndex < visiblePipeGroups.length - 1
  const pipePositionLabel = selectedPipeIndex >= 0
    ? `Pipe ${selectedPipeIndex + 1} of ${visiblePipeGroups.length}`
    : 'No pipe selected'
  const pipeReviewOptions = useMemo<PipeReviewOption[]>(() => {
    let hasUnreviewedPreviousPipe = false
    return visiblePipeGroups.map((group) => {
      const pipeId = recordId(group.ml_id)
      const spanLabel = assetIdInfo(group)
      const label = spanLabel === '-' ? `[${displayValue(group.ml_name)}]` : `[${displayValue(group.ml_name)}] ${spanLabel}`
      const option = {
        pipeId,
        label,
        disabled: pipeId !== selectedPipeId && hasUnreviewedPreviousPipe,
      }
      if (!reviewedPipeIds[pipeId]) {
        hasUnreviewedPreviousPipe = true
      }
      return option
    })
  }, [reviewedPipeIds, selectedPipeId, visiblePipeGroups])
  const groupedObservations = useMemo(() => observationDistanceGroups(observations), [observations])
  const gradeThreePlusCount = useMemo(
    () => pipeGradeThreePlusCount(selectedPipeId, groupedObservations, observationDefectSelections),
    [groupedObservations, observationDefectSelections, selectedPipeId],
  )
  const candidates = useMemo(() => pipeSearchCandidates(candidatePipes), [candidatePipes])
  const showCandidateList = candidateOpen && searchTerm.trim().length >= 2
  const selectedMediaMode = useMemo<MediaSourceMode>(() => mediaSourceMode(), [])
  const canBuildReadOnlyExport = readOnly
    && visiblePipeGroups.length > 0
    && visiblePipeGroups.every((group) => Boolean(pipeObservationCache[recordId(group.ml_id)]))
  const canShowDefectTable = Boolean(selectedInspection && observationStatus === 'ready')
  const hasVideoDefectLayout = Boolean(canShowDefectTable && inspectionMedia.videos.length)
  const videoDefectLayoutStyle = hasVideoDefectLayout
    ? ({ '--amteam-defect-table-pane-width': `${videoDefectTableWidth}px` } as CSSProperties)
    : undefined
  const defectColumnTemplate = useMemo(
    () => DEFECT_COLUMN_KEYS
      .map((key) => `minmax(${MIN_DEFECT_COLUMN_WIDTHS[key]}px, ${defectColumnWidths[key]}fr)`)
      .join(' '),
    [defectColumnWidths],
  )
  const defectTreelistStyle = { '--amteam-defect-columns': defectColumnTemplate } as CSSProperties
  const maxVideoDefectTableWidth = () => {
    const documentWidth = documentRef.current?.getBoundingClientRect().width ?? (VIDEO_DEFECT_MIN_WIDTH + VIDEO_DEFECT_TABLE_DEFAULT_WIDTH + VIDEO_DEFECT_SPLITTER_WIDTH)
    return Math.max(
      VIDEO_DEFECT_TABLE_MIN_WIDTH,
      documentWidth - VIDEO_DEFECT_MIN_WIDTH - VIDEO_DEFECT_SPLITTER_WIDTH,
    )
  }
  const boundedVideoDefectTableWidth = (value: number) => Math.min(Math.max(value, VIDEO_DEFECT_TABLE_MIN_WIDTH), maxVideoDefectTableWidth())
  const startVideoDefectResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!documentRef.current) return
    event.preventDefault()
    const documentRight = documentRef.current.getBoundingClientRect().right
    setVideoDefectTableWidth(boundedVideoDefectTableWidth(documentRight - event.clientX - VIDEO_DEFECT_SPLITTER_WIDTH))

    const moveResize = (moveEvent: PointerEvent) => {
      setVideoDefectTableWidth(boundedVideoDefectTableWidth(documentRight - moveEvent.clientX - VIDEO_DEFECT_SPLITTER_WIDTH))
    }
    const stopResize = () => {
      window.removeEventListener('pointermove', moveResize)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    window.addEventListener('pointermove', moveResize)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }
  const adjustVideoDefectWidth = (delta: number) => {
    setVideoDefectTableWidth((currentWidth) => boundedVideoDefectTableWidth(currentWidth + delta))
  }
  const boundedDefectColumnWidth = (key: DefectColumnKey, value: number) => Math.max(MIN_DEFECT_COLUMN_WIDTHS[key], Math.round(value))
  const setDefectColumnWidth = (key: DefectColumnKey, value: number) => {
    setDefectColumnWidths((currentWidths) => ({
      ...currentWidths,
      [key]: boundedDefectColumnWidth(key, value),
    }))
  }
  const adjustDefectColumnWidth = (key: DefectColumnKey, delta: number) => {
    setDefectColumnWidths((currentWidths) => ({
      ...currentWidths,
      [key]: boundedDefectColumnWidth(key, currentWidths[key] + delta),
    }))
  }
  const startDefectColumnResize = (event: ReactPointerEvent<HTMLButtonElement>, key: DefectColumnKey) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = defectColumnWidths[key]

    const moveResize = (moveEvent: PointerEvent) => {
      setDefectColumnWidth(key, startWidth + moveEvent.clientX - startX)
    }
    const stopResize = () => {
      window.removeEventListener('pointermove', moveResize)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    window.addEventListener('pointermove', moveResize)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }
  const defectColumnResizer = (key: DefectColumnKey, label: string) => (
    <button
      type="button"
      className="amteam-defect-column-resizer"
      aria-label={`Resize ${label} column`}
      onPointerDown={(event) => startDefectColumnResize(event, key)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          adjustDefectColumnWidth(key, -12)
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          adjustDefectColumnWidth(key, 12)
        }
        if (event.key === 'Home') {
          event.preventDefault()
          setDefectColumnWidth(key, MIN_DEFECT_COLUMN_WIDTHS[key])
        }
      }}
    >
      <span aria-hidden="true" />
    </button>
  )
  const toggleReviewNavigation = () => {
    setReviewNavigationCollapsed((current) => {
      if (!current) setCandidateOpen(false)
      return !current
    })
  }

  return (
    <main className={`amteam-page${readOnly ? ' is-read-only' : ''}`} aria-readonly={readOnly ? 'true' : undefined}>
      <section
        className={`amteam-workspace ${isReviewNavigationCollapsed ? 'navigation-collapsed' : ''} ${
          hideReviewNavigation ? 'navigation-hidden' : ''
        }`}
      >
        {!hideReviewNavigation ? (
          <aside className={`amteam-sidebar ${isReviewNavigationCollapsed ? 'collapsed' : ''}`}>
          <section className="amteam-navigation-panel" aria-label="Review navigation">
            <header className="amteam-navigation-panel-header">
              {!isReviewNavigationCollapsed ? (
                <div>
                  <span>Review navigation</span>
                </div>
              ) : null}
              <button
                type="button"
                aria-expanded={!isReviewNavigationCollapsed}
                aria-label={isReviewNavigationCollapsed ? 'Expand review navigation' : 'Collapse review navigation'}
                title={isReviewNavigationCollapsed ? 'Expand review navigation' : 'Collapse review navigation'}
                onClick={toggleReviewNavigation}
              >
                {isReviewNavigationCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </button>
            </header>

            {!isReviewNavigationCollapsed ? (
              <div className="amteam-navigation-panel-body">
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

                {pipeStatus === 'idle' ? <StatusMessage icon="empty" message="Enter a project title or address." /> : null}
                {pipeStatus === 'loading' ? <StatusMessage icon="loading" message="Loading pipes and inspections." /> : null}
                {pipeStatus === 'error' ? <StatusMessage icon="error" tone="error" message={errorMessage} /> : null}
                {pipeStatus === 'ready' && visiblePipeGroups.length === 0 ? (
                  <StatusMessage icon="empty" message={`No exact pipe matches found for ${lastQuery}.`} />
                ) : null}

                {inspectionDateOptions.length > 0 ? (
                  <section className="amteam-inspection-filter">
                    <InspectionDateSelect
                      options={inspectionDateOptions}
                      selectedDateKey={selectedInspectionDateKey}
                      onSelectDate={selectInspectionDate}
                      canShowInspectionInfo={Boolean(selectedInspection)}
                      onShowInspectionInfo={() => setInspectionDetailsOpen(true)}
                    />
                  </section>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                className="amteam-navigation-panel-rail"
                aria-label="Expand review navigation"
                onClick={toggleReviewNavigation}
              >
                <Search size={17} />
                <span>Search</span>
                <strong>{visiblePipeGroups.length.toLocaleString()}</strong>
              </button>
            )}
          </section>
          </aside>
        ) : null}

        <section className="amteam-document-shell">
          <div
            className={[
              'amteam-document',
              hasVideoDefectLayout ? 'with-video-defect-row' : '',
            ].filter(Boolean).join(' ')}
            ref={documentRef}
            style={videoDefectLayoutStyle}
          >
            {selectedInspection ? (
              <section
                className={`amteam-summary-grid ${observationStatus === 'ready' && inspectionMedia.videos.length ? 'with-video' : ''}`}
              >
                {observationStatus === 'ready' ? (
                  <PipeDefectReviewPanel
                    inspection={selectedInspection}
                    pipeOptions={pipeReviewOptions}
                    selectedPipeId={selectedPipeId}
                    gradeThreePlusCount={gradeThreePlusCount}
                    reviewInput={pipeReviewInputs[selectedPipeId] ?? emptyPipeReviewInput()}
                    currentVideoFrame={activeVideoFrame}
                    pipePositionLabel={pipePositionLabel}
                    hasPreviousPipe={hasPreviousPipe}
                    hasNextPipe={hasNextPipe}
                    onReviewInputChange={(input) => updatePipeReviewInput(selectedPipeId, input)}
                    onCaptureCloggingFrame={captureCloggingFrame}
                    onJumpToCloggingFrame={jumpToCloggingFrame}
                    onPreviousPipe={selectPreviousPipe}
                    onSelectPipe={selectPipeById}
                    onShowPipeInfo={showSelectedPipeInfo}
                    onNextPipe={selectNextPipe}
                    onGenerateReport={generateReviewReport}
                    canDownloadExport={Boolean(generatedReviewReport) || canBuildReadOnlyExport}
                    onDownloadExport={downloadGeneratedReviewExport}
                    readOnly={readOnly}
                  />
                ) : null}

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

            {hasVideoDefectLayout ? (
              <button
                type="button"
                className="amteam-video-defect-splitter"
                aria-label="Resize inspection video and defect table"
                aria-orientation="vertical"
                onPointerDown={startVideoDefectResize}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    adjustVideoDefectWidth(24)
                  }
                  if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    adjustVideoDefectWidth(-24)
                  }
                  if (event.key === 'Home') {
                    event.preventDefault()
                    setVideoDefectTableWidth(VIDEO_DEFECT_TABLE_MIN_WIDTH)
                  }
                  if (event.key === 'End') {
                    event.preventDefault()
                    setVideoDefectTableWidth(maxVideoDefectTableWidth())
                  }
                }}
              >
                <span aria-hidden="true" />
              </button>
            ) : null}

            {canShowDefectTable ? (
              <section
                className="amteam-observation-list amteam-defect-treelist"
                role="tree"
                aria-label="Defect observations by distance"
                style={defectTreelistStyle}
              >
                <div className="amteam-defect-treelist-header" role="presentation">
                  <span className="amteam-defect-header-cell observation">
                    <span className="amteam-defect-header-full">Observation</span>
                    <span className="amteam-defect-header-abbr">Obs.</span>
                    {defectColumnResizer('observation', 'Observation')}
                  </span>
                  <span className="amteam-defect-header-cell defect">
                    <span className="amteam-defect-header-full">Defect</span>
                    <span className="amteam-defect-header-abbr">Def.</span>
                    {defectColumnResizer('defect', 'Defect')}
                  </span>
                  <span className="amteam-defect-header-cell review">
                    <span className="amteam-defect-header-full">Review</span>
                    <span className="amteam-defect-header-abbr">Rev.</span>
                    {defectColumnResizer('review', 'Review')}
                  </span>
                  <span className="amteam-defect-header-cell extensive">
                    <span className="amteam-defect-header-full">Extensive</span>
                    <span className="amteam-defect-header-abbr">Ext.</span>
                    {defectColumnResizer('extensive', 'Extensive')}
                  </span>
                  <span className="amteam-defect-header-cell snapshot">
                    <span className="amteam-defect-header-full">Snapshot</span>
                    <span className="amteam-defect-header-abbr">Snap.</span>
                    {defectColumnResizer('snapshot', 'Snapshot')}
                  </span>
                </div>
                {groupedObservations.length === 0 ? (
                  <div className="amteam-defect-empty-row" role="presentation">
                    <AlertCircle size={24} aria-hidden="true" />
                    <span>No graded defect observations found.</span>
                  </div>
                ) : null}
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
                  const hasDistanceGroupHighAmScore = distanceGroupHasHighAmScore(groupSelection)
                  const isNoHighScoreConfirmed = groupSelection.noHighScoreConfirmed
                  const hasDistanceGroupValidationFailure = Boolean(distanceGroupValidationFailures[scopedGroupKey])
                  const distanceConfirmClasses = [
                    'amteam-distance-confirm-button',
                    isNoHighScoreConfirmed ? 'confirmed' : '',
                    hasDistanceGroupValidationFailure ? 'needs-review' : '',
                  ].filter(Boolean).join(' ')

                  return (
                    <div className="amteam-defect-treelist-branch" key={group.key}>
                      <div
                        className={[
                          'amteam-defect-row',
                          'amteam-defect-distance-row',
                          isGroupCollapsed ? 'collapsed' : '',
                          hasDistanceGroupValidationFailure ? 'needs-review' : '',
                        ].filter(Boolean).join(' ')}
                        role="treeitem"
                        aria-expanded={!isGroupCollapsed}
                      >
                        <div className="amteam-defect-cell amteam-defect-tree-cell">
                          <button
                            type="button"
                            className="amteam-defect-tree-toggle"
                            aria-expanded={!isGroupCollapsed}
                            onClick={() => toggleDistanceGroup(scopedGroupKey)}
                          >
                            {isGroupCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                            <strong>{group.label}</strong>
                          </button>
                        </div>

                        <div className="amteam-defect-cell amteam-defect-distance-defect-cell">
                          <div className="amteam-defect-review-controls">
                            <label className="amteam-tree-review-control amteam-tree-am-score-control">
                              <span>AM Score</span>
                              <input
                                type="number"
                                min="3"
                                max="5"
                                step="1"
                                inputMode="numeric"
                                disabled={readOnly || !majorObservationEntry}
                                value={majorObservationEntry ? groupSelection.amScore || DEFAULT_MAJOR_DEFECT_AM_SCORE : ''}
                                onChange={(event) => updateDistanceGroupAmScore(scopedGroupKey, event.currentTarget.value)}
                              />
                            </label>
                            <label className="amteam-tree-review-control">
                              <input
                                aria-label="Defect comment"
                                list="amteam-defect-comment-options"
                                disabled={readOnly || !majorObservationEntry}
                                placeholder="Select or enter"
                                value={majorObservationEntry ? groupSelection.defectComment : ''}
                                onChange={(event) => updateDistanceGroupDefectComment(scopedGroupKey, event.currentTarget.value)}
                              />
                            </label>
                          </div>
                        </div>

                        <div className="amteam-defect-cell amteam-defect-distance-review-cell">
                          <div className="amteam-distance-review-status">
                              <button
                                type="button"
                                className={distanceConfirmClasses}
                                disabled={readOnly || hasDistanceGroupHighAmScore}
                              title={
                                hasDistanceGroupHighAmScore
                                  ? 'AM score greater or equal to 3 selected'
                                  : isNoHighScoreConfirmed
                                    ? 'No AM score greater or equal to 3 confirmed'
                                    : 'Confirm no AM score greater or equal to 3'
                              }
                              onClick={() => toggleDistanceGroupNoHighScoreConfirmation(scopedGroupKey)}
                            >
                              {hasDistanceGroupHighAmScore
                                ? 'Scored 3+'
                                : isNoHighScoreConfirmed
                                  ? 'Confirmed'
                                  : 'Confirm none'}
                            </button>
                          </div>
                        </div>

                        <div className="amteam-defect-cell amteam-defect-distance-extensive-cell" aria-hidden="true" />

                        <div className="amteam-defect-cell amteam-defect-distance-snapshot-cell">
                          {majorObservationEntry ? (
                            <ObservationImage
                              mediaMode={selectedMediaMode}
                              mediaRoot={inspectionMedia.media_root}
                              observation={majorObservationEntry.observation}
                              selectedUrl={snapshotSelections[pipeScopedKey(selectedPipeId, majorObservationEntry.cardKey)]}
                              readOnly={readOnly}
                              onSelectedUrlChange={(imageUrl) => updateObservationSnapshotSelection(pipeScopedKey(selectedPipeId, majorObservationEntry.cardKey), imageUrl)}
                            />
                          ) : (
                            <span>Select major</span>
                          )}
                        </div>
                      </div>

                      {!isGroupCollapsed ? (
                        <div className="amteam-defect-child-rows" role="group">
                          {observationEntries.map(({ observation, cardKey, observationNumber }) => {
                            const scopedCardKey = pipeScopedKey(selectedPipeId, cardKey)
                            const groupHasMajorDefect = Boolean(groupSelection.majorKey)
                            const isMajorDefect = groupSelection.majorKey === cardKey
                            const isOtherDefect = groupSelection.otherKeys.includes(cardKey)
                            const defectRole: ObservationDefectRole = isMajorDefect ? 'major' : isOtherDefect ? 'other' : ''
                            const canMarkExtensive = isMajorDefect || isOtherDefect
                            const isExtensiveDefect = canMarkExtensive && Boolean(extensiveDefectSelections[scopedCardKey])
                            const observationSeekVideo = selectedVideoForObservationJump()
                            const observationSeekTime = observationSeekSeconds(observation, observationSeekVideo)
                            const canJumpToObservationFrame = observationSeekTime !== null
                            const rowClasses = [
                              'amteam-defect-row',
                              'amteam-defect-observation-row',
                              canJumpToObservationFrame ? 'has-video-frame' : '',
                              isMajorDefect ? 'major-defect' : '',
                              isOtherDefect ? 'other-defect' : '',
                              isExtensiveDefect ? 'extensive-defect' : '',
                            ].filter(Boolean).join(' ')

                            return (
                              <article
                                className={rowClasses}
                                key={cardKey}
                                role="treeitem"
                                tabIndex={canJumpToObservationFrame ? 0 : undefined}
                                title={canJumpToObservationFrame ? `Jump video to ${formatMediaTime(observationSeekTime ?? 0)}` : undefined}
                                onClick={(event) => {
                                  if (!canJumpToObservationFrame || isInteractiveEventTarget(event.target)) return
                                  jumpToObservationFrame(observation)
                                }}
                                onKeyDown={(event) => {
                                  if (!canJumpToObservationFrame || isInteractiveEventTarget(event.target)) return
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    jumpToObservationFrame(observation)
                                  }
                                }}
                              >
                                <div className="amteam-defect-cell amteam-defect-tree-cell child">
                                  <button
                                    type="button"
                                    className="amteam-defect-mlo-button"
                                    title="Show observation details"
                                    onClick={() => setSelectedObservationDetails({ observation })}
                                  >
                                    {displayValue(observation.mlo_id)}
                                  </button>
                                </div>

                                <div
                                  className="amteam-defect-cell amteam-defect-observation-text-cell"
                                  title={displayValue(observation.observation_text)}
                                >
                                  <strong>{displayValue(observation.code)} (Grade {displayValue(observation.grade)})</strong>
                                </div>

                                <div className="amteam-defect-cell amteam-defect-observation-review-cell">
                                  <label className="amteam-observation-role-control">
                                    <select
                                      value={defectRole}
                                      aria-label={`Observation ${observationNumber} defect role`}
                                      disabled={readOnly}
                                      onChange={(event) => updateObservationDefectRole(
                                        scopedGroupKey,
                                        cardKey,
                                        event.currentTarget.value as ObservationDefectRole,
                                      )}
                                    >
                                      <option value="">None</option>
                                      <option value="major">Major Defect</option>
                                      <option value="other" disabled={!groupHasMajorDefect || isMajorDefect}>Other Defect</option>
                                    </select>
                                  </label>
                                </div>

                                <div className="amteam-defect-cell amteam-defect-observation-extensive-cell">
                                  <label
                                    className={isExtensiveDefect ? 'selected' : !canMarkExtensive ? 'disabled' : ''}
                                    aria-label={`Observation ${observationNumber} extensive defect`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isExtensiveDefect}
                                      disabled={readOnly || !canMarkExtensive}
                                      onChange={() => toggleObservationExtensive(scopedCardKey)}
                                    />
                                  </label>
                                </div>

                                <div className="amteam-defect-cell amteam-defect-observation-snapshot-cell">
                                  <ObservationImage
                                    mediaMode={selectedMediaMode}
                                    mediaRoot={inspectionMedia.media_root}
                                    observation={observation}
                                    selectedUrl={snapshotSelections[scopedCardKey]}
                                    readOnly={readOnly}
                                    onSelectedUrlChange={(imageUrl) => updateObservationSnapshotSelection(scopedCardKey, imageUrl)}
                                  />
                                </div>
                              </article>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </section>
            ) : null}
          </div>
        </section>
      </section>
      {reviewNotice ? (
        <div className="amteam-review-notice" role="alert" aria-live="assertive">
          {reviewNotice.message}
        </div>
      ) : null}
      {reportProgressMessage ? <ReportProgressOverlay message={reportProgressMessage} /> : null}
      <ObservationDetailsDialog
        selection={selectedObservationDetails}
        onClose={() => setSelectedObservationDetails(null)}
      />
      <PipeDetailsDialog
        selection={selectedPipeDetails}
        onClose={() => setSelectedPipeDetails(null)}
      />
      <InspectionDetailsDialog
        inspection={isInspectionDetailsOpen ? selectedInspection : null}
        mediaMode={selectedMediaMode}
        mediaRoot={inspectionMedia.media_root}
        reports={inspectionMedia.reports}
        onClose={() => setInspectionDetailsOpen(false)}
      />
      <datalist id="amteam-defect-comment-options">
        {PIPE_REVIEW_COMMENT_OPTIONS.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </main>
  )
}
