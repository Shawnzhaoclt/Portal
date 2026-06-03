import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import type {
  BarSeriesOption,
  CustomSeriesOption,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
  LineSeriesOption,
} from 'echarts'
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  BadgeCheck,
  BarChart3,
  CalendarCheck,
  CalendarDays,
  ChartLine,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CirclePause,
  ClipboardClock,
  ClipboardCheck,
  ClipboardList,
  Database,
  Download,
  Filter,
  FilePenLine,
  Gauge,
  LayoutDashboard,
  Search,
  Table2,
  UserRound,
  X,
} from 'lucide-react'
import './CriticalTeamDashboard.css'
import { EChart, type EChartHandle } from '../../EChart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  fetchCriticalTeamOverview,
  fetchCriticalTeamFilterOptions,
  fetchCriticalTeamSheet,
  fetchCriticalTeamSource,
  fetchCriticalTeamSummary,
  fetchCriticalTeamWorkorders,
  type CriticalTeamFilters,
  type CriticalTeamOverviewFilters,
} from './api'
import type {
  AssetRow,
  CriticalTeamFilterOptionsResponse,
  CriticalTeamOverviewResponse,
  CriticalTeamSheetResponse,
  CriticalTeamSourceResponse,
  CriticalTeamSummaryResponse,
  CriticalTeamWorkordersResponse,
} from './types'

type SheetKind = 'overview' | 'chart' | 'table' | 'details'

type SheetDefinition = {
  id: string
  title: string
  kind: SheetKind
  category: 'Overview' | 'Charts' | 'Tables'
  description: string
  dateKey?: string
  groupColumn?: 'submit_to' | 'wo_closed_by'
  statusFilter?: boolean
}

const DETAIL_COLUMNS = [
  { key: 'workorder_id', label: 'Work Order ID', placeholder: 'ID' },
  { key: 'facility_id', label: 'Facility ID', placeholder: 'Facility' },
  { key: 'submit_to', label: 'Submit To', placeholder: 'Submitter' },
  { key: 'wo_closed_by', label: 'Closed By', placeholder: 'Reviewer' },
  { key: 'critical_team_status', label: 'Critical Team Status', placeholder: 'Status' },
  { key: 'project_start_date', label: 'Project Start Date', placeholder: 'YYYY-MM-DD' },
  { key: 'inspection_complete_date', label: 'Inspection Complete Date', placeholder: 'YYYY-MM-DD' },
  { key: 'report_complete_date', label: 'Report Complete Date', placeholder: 'YYYY-MM-DD' },
  { key: 'wo_closed_date', label: 'WO Closed Date', placeholder: 'YYYY-MM-DD' },
] as const

type DetailColumnKey = (typeof DETAIL_COLUMNS)[number]['key']
const DETAIL_DATE_COLUMN_KEYS = [
  'project_start_date',
  'inspection_complete_date',
  'report_complete_date',
  'wo_closed_date',
] as const
const DETAIL_NUMBER_COLUMN_KEYS = ['workorder_id', 'facility_id'] as const
const DETAIL_CATEGORY_COLUMN_KEYS = ['submit_to', 'wo_closed_by', 'critical_team_status'] as const

type DetailDateColumnKey = (typeof DETAIL_DATE_COLUMN_KEYS)[number]
type DetailNumberColumnKey = (typeof DETAIL_NUMBER_COLUMN_KEYS)[number]
type DetailCategoryColumnKey = (typeof DETAIL_CATEGORY_COLUMN_KEYS)[number]
type DetailDateFilterMode = 'any' | 'exact' | 'between' | 'before' | 'after'
type DetailNumberFilterMode = 'any' | 'exact' | 'between' | 'greater' | 'less'
type DetailDateFilter = {
  mode: DetailDateFilterMode
  from: string
  to: string
}
type DetailNumberFilter = {
  mode: DetailNumberFilterMode
  from: string
  to: string
}
type DetailColumnFilters = {
  numbers: Record<DetailNumberColumnKey, DetailNumberFilter>
  categories: Record<DetailCategoryColumnKey, string[]>
  dates: Record<DetailDateColumnKey, DetailDateFilter>
}
type DetailSortDirection = 'asc' | 'desc'
type DetailSortState = {
  column: DetailColumnKey
  direction: DetailSortDirection
}
type PivotRow = {
  group: string
  total: number
  values: number[]
}
type PivotSortKey = 'group' | 'total' | `month:${string}`
type PivotSortState = {
  key: PivotSortKey
  direction: DetailSortDirection
}

const DETAIL_PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500]
const DEFAULT_DETAIL_SORT: DetailSortState = { column: 'project_start_date', direction: 'desc' }
const CHART_EXPORT_PIXEL_RATIO = 300 / 96

function isDetailDateColumn(column: DetailColumnKey): column is DetailDateColumnKey {
  return (DETAIL_DATE_COLUMN_KEYS as readonly string[]).includes(column)
}

function isDetailNumberColumn(column: DetailColumnKey): column is DetailNumberColumnKey {
  return (DETAIL_NUMBER_COLUMN_KEYS as readonly string[]).includes(column)
}

function isDetailCategoryColumn(column: DetailColumnKey): column is DetailCategoryColumnKey {
  return (DETAIL_CATEGORY_COLUMN_KEYS as readonly string[]).includes(column)
}

function createEmptyDetailColumnFilters(): DetailColumnFilters {
  return {
    numbers: Object.fromEntries(
      DETAIL_NUMBER_COLUMN_KEYS.map((column) => [column, { mode: 'any', from: '', to: '' }]),
    ) as Record<DetailNumberColumnKey, DetailNumberFilter>,
    categories: {
      submit_to: [],
      wo_closed_by: [],
      critical_team_status: [],
    },
    dates: Object.fromEntries(
      DETAIL_DATE_COLUMN_KEYS.map((column) => [column, { mode: 'any', from: '', to: '' }]),
    ) as Record<DetailDateColumnKey, DetailDateFilter>,
  }
}

const SHEETS: SheetDefinition[] = [
  {
    id: 'overview',
    title: 'Critical Team Overview',
    kind: 'overview',
    category: 'Overview',
    description: 'Cityworks Critical Asset Inspection work-order source and completion summary.',
  },
  {
    id: 'insp-proj-start-date',
    title: 'Inspection Project Start Date',
    kind: 'chart',
    category: 'Charts',
    description: 'Count of inspection work orders by project start month and assigned submitter.',
    dateKey: 'project_start',
    groupColumn: 'submit_to',
  },
  {
    id: 'insp-comp-date-bar-chart',
    title: 'Inspection Completion Date Chart',
    kind: 'chart',
    category: 'Charts',
    description: 'Inspection completion date counts grouped by submitter.',
    dateKey: 'inspection_complete',
    groupColumn: 'submit_to',
  },
  {
    id: 'report-comp-date-chart',
    title: 'Report Completion Date Chart',
    kind: 'chart',
    category: 'Charts',
    description: 'Report completion date counts grouped by submitter.',
    dateKey: 'report_complete',
    groupColumn: 'submit_to',
  },
  {
    id: 'insp-comp-date-reviews',
    title: 'Inspection Completion Date Reviews',
    kind: 'chart',
    category: 'Charts',
    description: 'Ready-for-review and review-complete work orders by closed date and reviewer.',
    dateKey: 'work_order_closed',
    groupColumn: 'wo_closed_by',
    statusFilter: true,
  },
  {
    id: 'insp-comp-date-table',
    title: 'Inspection Completion Date Table',
    kind: 'table',
    category: 'Tables',
    description: 'Inspection completion date cross-tab by submitter.',
    dateKey: 'inspection_complete',
    groupColumn: 'submit_to',
  },
  {
    id: 'report-comp-date-table',
    title: 'Report Completion Date Table',
    kind: 'table',
    category: 'Tables',
    description: 'Report completion date cross-tab by submitter.',
    dateKey: 'report_complete',
    groupColumn: 'submit_to',
  },
  {
    id: 'insp-comp-date-reviews-table',
    title: 'Inspection Completion Date Reviews Table',
    kind: 'table',
    category: 'Tables',
    description: 'Review-complete cross-tab by reviewer and closed month.',
    dateKey: 'work_order_closed',
    groupColumn: 'wo_closed_by',
    statusFilter: true,
  },
  {
    id: 'workorders',
    title: 'Work Order Detail',
    kind: 'details',
    category: 'Tables',
    description: 'Operational detail rows from the same Cityworks source.',
  },
]

const INITIAL_FILTERS: CriticalTeamFilters = {
  tableauDefaults: true,
  years: [],
  submitTo: [],
  closedBy: '',
  statuses: [],
  search: '',
}

const TABLEAU_SUBMITTO_COLORS: Record<string, string> = {
  Unassigned: '#4e79a7',
  'Volpe, Fred': '#59a14f',
  'McCray, Spencer': '#76b7b2',
  'Irish, Jason': '#b07aa1',
  'Foreman, Trent': '#e15759',
  'Williams, Caleb': '#edc948',
  'Clapper, John': '#f28e2b',
}

const TABLEAU_REVIEWER_COLORS: Record<string, string> = {
  'Ledford, Dustin': '#4e79a7',
  'McCray, Spencer': '#59a14f',
  Unassigned: '#eb2106',
  'Clapper, John': '#edc948',
  'Irish, Jason': '#f28e2b',
}

const TABLEAU_FALLBACK_COLORS = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#bab0ac',
]

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type MonthBucket = {
  label: string
  year: string
  month: number
  quarter: string
}

type ChartBoundaryLine = {
  boundaryIndex: number
  yTop: number
  isYearBoundary: boolean
}

type ChartBarSegmentLabel = {
  monthIndex: number
  startValue: number
  endValue: number
  value: number
  labelText: string
  color: string
}

type ChartViewMode = 'count' | 'percent'

type PeriodLabelGroup = {
  label: string
  startIndex: number
  endIndex: number
  isDate?: boolean
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—'
  }
  return new Intl.NumberFormat().format(value)
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '-'
  }

  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value > 0 && value < 1 ? 1 : 0,
  }).format(value)}%`
}

function labelForValue(value: string) {
  return value === 'null' ? 'No Date' : value
}

function downloadDataUrl(dataUrl: string, fileName: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function fileNameSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'
}

function valueText(value: AssetRow[string]) {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }
  if (typeof value === 'number') {
    return formatNumber(value)
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10)
  }
  return value
}

function parseDatePickerValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)

  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatDatePickerValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateToMonthPickerValue(value: string) {
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : ''
}

function monthStartDate(value: string) {
  return /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : ''
}

function monthEndDate(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) return ''

  const year = Number(match[1])
  const month = Number(match[2])
  const lastDay = new Date(year, month, 0).getDate()
  return `${value}-${String(lastDay).padStart(2, '0')}`
}

function formatOverviewMonth(value: string) {
  const bucket = parseMonthBucket(dateToMonthPickerValue(value))
  if (!bucket) return value
  return `${MONTH_NAMES[bucket.month - 1]} ${bucket.year}`
}

function createRecentOverviewDateRange(monthCount: number) {
  const today = new Date()
  const endMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const start = new Date(today.getFullYear(), today.getMonth() - monthCount + 1, 1)
  const startMonth = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`

  return {
    dateFrom: monthStartDate(startMonth),
    dateTo: monthEndDate(endMonth),
  }
}

function createDefaultOverviewFilters(): CriticalTeamOverviewFilters {
  const dateRange = createRecentOverviewDateRange(12)

  return {
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    submitTo: [],
    closedBy: [],
  }
}

function monthLabelsForDateRange(dateFrom: string, dateTo: string) {
  const startDate = parseDatePickerValue(dateFrom)
  const endDate = parseDatePickerValue(dateTo)
  if (!startDate || !endDate) return []

  const start = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1)
  if (start > end) {
    return monthLabelsForDateRange(dateTo, dateFrom)
  }

  const months: string[] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
}

function overviewAxisLabel(value: string) {
  const bucket = parseMonthBucket(value)
  if (!bucket) return value
  return MONTH_NAMES[bucket.month - 1]
}

function overviewDateRangeLabel(filters: CriticalTeamOverviewFilters, data: CriticalTeamOverviewResponse | null) {
  const dateFrom = data?.filters.date_from ?? filters.dateFrom
  const dateTo = data?.filters.date_to ?? filters.dateTo

  if (!dateFrom && !dateTo) return 'All time'
  if (dateFrom && dateTo) return `${formatOverviewMonth(dateFrom)} to ${formatOverviewMonth(dateTo)}`
  if (dateFrom) return `From ${formatOverviewMonth(dateFrom)}`
  return `Through ${formatOverviewMonth(dateTo)}`
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function columnLetter(index: number) {
  let column = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    column = String.fromCharCode(65 + remainder) + column
    value = Math.floor((value - 1) / 26)
  }
  return column
}

function xlsxCell(value: AssetRow[string], column: DetailColumnKey, rowIndex: number, columnIndex: number) {
  const cellRef = `${columnLetter(columnIndex)}${rowIndex}`
  if (value === null || value === undefined || value === '') {
    return `<c r="${cellRef}"/>`
  }

  const rawText = String(value).trim()
  if ((column === 'workorder_id' || column === 'facility_id') && /^\d+$/.test(rawText)) {
    return `<c r="${cellRef}"><v>${escapeXml(rawText)}</v></c>`
  }

  return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(String(valueText(value)))}</t></is></c>`
}

function xlsxTextCell(columnIndex: number, rowIndex: number, value: string) {
  const cellRef = `${columnLetter(columnIndex)}${rowIndex}`
  return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`
}

function xlsxNumberCell(columnIndex: number, rowIndex: number, value: number | null | undefined) {
  const cellRef = `${columnLetter(columnIndex)}${rowIndex}`
  if (value === null || value === undefined || Number.isNaN(value)) {
    return `<c r="${cellRef}"/>`
  }
  return `<c r="${cellRef}"><v>${value}</v></c>`
}

function encodeText(value: string) {
  return new TextEncoder().encode(value)
}

const CRC32_TABLE = (() => {
  const table: number[] = []
  for (let index = 0; index < 256; index += 1) {
    let current = index
    for (let bit = 0; bit < 8; bit += 1) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    }
    table[index] = current >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function concatBytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function zipDateTime(date: Date) {
  return {
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

function createZip(files: Array<{ name: string; content: string }>) {
  const now = zipDateTime(new Date())
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  const entries: Array<{ nameBytes: Uint8Array; bytes: Uint8Array; crc: number; offset: number }> = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encodeText(file.name)
    const bytes = encodeText(file.content)
    const fileCrc = crc32(bytes)
    const header = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, now.time, true)
    view.setUint16(12, now.date, true)
    view.setUint32(14, fileCrc, true)
    view.setUint32(18, bytes.length, true)
    view.setUint32(22, bytes.length, true)
    view.setUint16(26, nameBytes.length, true)
    header.set(nameBytes, 30)

    entries.push({ nameBytes, bytes, crc: fileCrc, offset })
    localChunks.push(header, bytes)
    offset += header.length + bytes.length
  }

  const centralOffset = offset
  for (const entry of entries) {
    const header = new Uint8Array(46 + entry.nameBytes.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, 0x0800, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, now.time, true)
    view.setUint16(14, now.date, true)
    view.setUint32(16, entry.crc, true)
    view.setUint32(20, entry.bytes.length, true)
    view.setUint32(24, entry.bytes.length, true)
    view.setUint16(28, entry.nameBytes.length, true)
    view.setUint32(42, entry.offset, true)
    header.set(entry.nameBytes, 46)
    centralChunks.push(header)
    offset += header.length
  }

  const centralSize = offset - centralOffset
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, centralOffset, true)

  return concatBytes([...localChunks, ...centralChunks, end])
}

function worksheetPackage(sheetName: string, worksheet: string) {
  const safeSheetName = sheetName.replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || 'Sheet1'

  return createZip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(safeSheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    },
    { name: 'xl/worksheets/sheet1.xml', content: worksheet },
  ])
}

function createWorkOrderXlsx(rows: AssetRow[]) {
  const headerCells = DETAIL_COLUMNS.map(
    (column, columnIndex) =>
      `<c r="${columnLetter(columnIndex)}1" t="inlineStr"><is><t>${escapeXml(column.label)}</t></is></c>`,
  ).join('')
  const bodyRows = rows
    .map((row, rowIndex) => {
      const sheetRowIndex = rowIndex + 2
      const cells = DETAIL_COLUMNS.map((column, columnIndex) =>
        xlsxCell(row[column.key], column.key, sheetRowIndex, columnIndex),
      ).join('')
      return `<row r="${sheetRowIndex}">${cells}</row>`
    })
    .join('')
  const lastCell = `${columnLetter(DETAIL_COLUMNS.length - 1)}${Math.max(1, rows.length + 1)}`
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetData>
    <row r="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
</worksheet>`
  return worksheetPackage('Work Order Detail', worksheet)
}

function downloadWorkOrderGridRows(rows: AssetRow[]) {
  const workbook = createWorkOrderXlsx(rows)
  const blob = new Blob([workbook], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `work-order-detail-${new Date().toISOString().slice(0, 10)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function hasActiveDetailFilters(filters: DetailColumnFilters) {
  return (
    DETAIL_NUMBER_COLUMN_KEYS.some((column) => {
      const filter = filters.numbers[column]
      if (filter.mode === 'any') {
        return false
      }
      if (filter.mode === 'between') {
        return Boolean(filter.from || filter.to)
      }
      return Boolean(filter.from)
    }) ||
    Object.values(filters.categories).some((values) => values.length > 0) ||
    DETAIL_DATE_COLUMN_KEYS.some((column) => {
      const filter = filters.dates[column]
      if (filter.mode === 'any') {
        return false
      }
      if (filter.mode === 'between') {
        return Boolean(filter.from || filter.to)
      }
      return Boolean(filter.from)
    })
  )
}

function colorForGroup(group: string, groupColumn: 'submit_to' | 'wo_closed_by' | undefined, index: number) {
  if (groupColumn === 'submit_to') {
    return TABLEAU_SUBMITTO_COLORS[group] ?? TABLEAU_FALLBACK_COLORS[index % TABLEAU_FALLBACK_COLORS.length]
  }
  if (groupColumn === 'wo_closed_by') {
    return TABLEAU_REVIEWER_COLORS[group] ?? TABLEAU_FALLBACK_COLORS[index % TABLEAU_FALLBACK_COLORS.length]
  }
  return TABLEAU_FALLBACK_COLORS[index % TABLEAU_FALLBACK_COLORS.length]
}

function readableLabelColor(hexColor: string) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexColor)
  if (!match) return '#0f172a'

  const red = Number.parseInt(match[1], 16)
  const green = Number.parseInt(match[2], 16)
  const blue = Number.parseInt(match[3], 16)
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000
  return brightness >= 145 ? '#0f172a' : '#ffffff'
}

function parseMonthBucket(label: string): MonthBucket | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label)
  if (!match) return null
  const month = Number(match[2])
  if (month < 1 || month > 12) return null

  return {
    label,
    year: match[1],
    month,
    quarter: `Q${Math.floor((month - 1) / 3) + 1}`,
  }
}

function monthAxisLabel(value: string) {
  const bucket = parseMonthBucket(value)
  if (!bucket) return value
  return MONTH_NAMES[bucket.month - 1]
}

function periodLabelGroups(
  buckets: Array<MonthBucket | null>,
  groupKey: (bucket: MonthBucket) => string,
  label: (bucket: MonthBucket) => string,
): PeriodLabelGroup[] {
  const groups: PeriodLabelGroup[] = []
  let activeKey = ''
  let activeLabel = ''
  let startIndex = -1

  buckets.forEach((bucket, index) => {
    if (!bucket) {
      if (startIndex >= 0) groups.push({ label: activeLabel, startIndex, endIndex: index - 1 })
      activeKey = ''
      activeLabel = ''
      startIndex = -1
      return
    }

    const nextKey = groupKey(bucket)
    if (startIndex < 0) {
      activeKey = nextKey
      activeLabel = label(bucket)
      startIndex = index
      return
    }

    if (activeKey !== nextKey) {
      groups.push({ label: activeLabel, startIndex, endIndex: index - 1 })
      activeKey = nextKey
      activeLabel = label(bucket)
      startIndex = index
    }
  })

  if (startIndex >= 0) {
    groups.push({ label: activeLabel, startIndex, endIndex: buckets.length - 1 })
  }

  return groups
}

function chartBoundaryLines(buckets: Array<MonthBucket | null>, maxValue: number): ChartBoundaryLine[] {
  const lineTop = Math.max(1, Math.ceil(maxValue * 1.05))

  return buckets.flatMap((bucket, index) => {
    if (!bucket || index === 0) return []

    const previous = buckets[index - 1]
    if (!previous) return []

    const isYearBoundary = previous.year !== bucket.year
    const isQuarterBoundary = isYearBoundary || previous.quarter !== bucket.quarter
    if (!isQuarterBoundary) return []

    return [
      {
        boundaryIndex: index,
        yTop: lineTop,
        isYearBoundary,
      },
    ]
  })
}

function chartBarSegmentLabels(
  months: string[],
  groups: string[],
  lookup: Map<string, number>,
  groupColumn: 'submit_to' | 'wo_closed_by' | undefined,
  labelText: (value: number, month: string, group: string) => string,
): ChartBarSegmentLabel[] {
  return months.flatMap((month, monthIndex) => {
    let stackStart = 0

    return groups.flatMap((group, groupIndex) => {
      const value = lookup.get(`${month}::${group}`) ?? 0
      const segment = {
        monthIndex,
        startValue: stackStart,
        endValue: stackStart + value,
        value,
        labelText: labelText(value, month, group),
        color: colorForGroup(group, groupColumn, groupIndex),
      }
      stackStart += value
      return value > 0 ? [segment] : []
    })
  })
}

function makeOverviewTrendOption(
  data: CriticalTeamOverviewResponse | null,
  filters: CriticalTeamOverviewFilters,
): EChartsOption {
  const effectiveDateFrom = data?.filters.date_from ?? filters.dateFrom
  const effectiveDateTo = data?.filters.date_to ?? filters.dateTo
  const monthsFromRange = monthLabelsForDateRange(effectiveDateFrom, effectiveDateTo)
  const monthsFromData = [
    ...new Set(data?.series.flatMap((series) => series.points.map((point) => point.month_label)) ?? []),
  ].sort()
  const months = monthsFromRange.length > 0 ? monthsFromRange : monthsFromData
  const seriesList = data?.series ?? []
  const monthBuckets = months.map(parseMonthBucket)
  const quarterLabelGroups = periodLabelGroups(
    monthBuckets,
    (bucket) => `${bucket.year}-${bucket.quarter}`,
    (bucket) => bucket.quarter,
  )
  const yearLabelGroups = periodLabelGroups(
    monthBuckets,
    (bucket) => bucket.year,
    (bucket) => bucket.year,
  )
  const monthLabelInterval = months.length > 30 ? 1 : 0
  const maxTrendValue = Math.max(0, ...seriesList.flatMap((series) => series.points.map((point) => point.count_value)))
  const boundaryLines = chartBoundaryLines(monthBuckets, maxTrendValue)
  const labelBandRuleSeries: CustomSeriesOption[] =
    months.length > 0
      ? [
          {
            type: 'custom',
            name: 'Overview period label row rules',
            coordinateSystem: 'cartesian2d',
            xAxisIndex: 0,
            yAxisIndex: 0,
            silent: true,
            clip: false,
            z: 1,
            data: [[0]],
            renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
              const coordSys = params.coordSys as unknown as { x: number; y: number; width: number; height: number }
              const labelBandTop = coordSys.y + coordSys.height
              const lineColor = '#d7e0e8'
              const x1 = coordSys.x
              const x2 = coordSys.x + coordSys.width
              const labelX = (group: PeriodLabelGroup) => {
                const startX = api.coord([months[group.startIndex], 0])[0]
                const endX = api.coord([months[group.endIndex], 0])[0]
                return (startX + endX) / 2
              }

              return {
                type: 'group',
                children: [
                  ...[24, 46, 66].map((offset) => ({
                    type: 'line',
                    shape: {
                      x1,
                      y1: labelBandTop + offset,
                      x2,
                      y2: labelBandTop + offset,
                    },
                    style: {
                      stroke: lineColor,
                      lineWidth: 1,
                    },
                  })),
                  ...quarterLabelGroups.map((group) => ({
                    type: 'text',
                    style: {
                      text: group.label,
                      x: labelX(group),
                      y: labelBandTop + 35,
                      fill: '#475569',
                      font: '700 13px Inter, system-ui, sans-serif',
                      textAlign: 'center',
                      textVerticalAlign: 'middle',
                    },
                  })),
                  ...yearLabelGroups.map((group) => ({
                    type: 'text',
                    style: {
                      text: group.label,
                      x: labelX(group),
                      y: labelBandTop + 57,
                      fill: '#0f172a',
                      font: '800 13px Inter, system-ui, sans-serif',
                      textAlign: 'center',
                      textVerticalAlign: 'middle',
                    },
                  })),
                ],
              } as CustomSeriesRenderItemReturn
            },
          },
        ]
      : []
  const dividerSeries: CustomSeriesOption[] =
    boundaryLines.length > 0
      ? [
          {
            type: 'custom',
            name: 'Overview period dividers',
            coordinateSystem: 'cartesian2d',
            xAxisIndex: 0,
            yAxisIndex: 0,
            silent: true,
            clip: false,
            z: 1,
            data: boundaryLines.map((line) => [line.boundaryIndex, 0, line.yTop, line.isYearBoundary ? 1 : 0]),
            renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
              const coordSys = params.coordSys as unknown as { y: number; height: number }
              const boundaryIndex = Number(api.value(0))
              const previousCenterX = api.coord([months[boundaryIndex - 1], 0])[0]
              const nextCenterX = api.coord([months[boundaryIndex], 0])[0]
              const x = (previousCenterX + nextCenterX) / 2
              const isYearBoundary = api.value(3) === 1
              const labelBandTop = coordSys.y + coordSys.height
              const y0 = labelBandTop + (isYearBoundary ? 66 : 46)
              const y1 = coordSys.y

              return {
                type: 'line',
                shape: { x1: x, y1: y0, x2: x, y2: y1 },
                style: {
                  stroke: isYearBoundary ? '#64748b' : '#cfd8e3',
                  lineWidth: isYearBoundary ? 2 : 1,
                  lineDash: isYearBoundary ? undefined : [4, 3],
                },
              }
            },
          },
        ]
      : []
  const lineSeries: LineSeriesOption[] = seriesList.map((series) => {
    const lookup = new Map(series.points.map((point) => [point.month_label, point.count_value]))

    return {
      name: series.label,
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 7,
      lineStyle: { width: 3, color: series.color },
      itemStyle: { color: series.color },
      areaStyle: {
        color: series.color,
        opacity: 0.08,
      },
      emphasis: { focus: 'series' },
      data: months.map((month) => lookup.get(month) ?? 0),
    }
  })

  return {
    color: seriesList.map((series) => series.color),
    animationDuration: 260,
    grid: { top: 62, right: 28, bottom: 72, left: 52, containLabel: true },
    tooltip: { trigger: 'axis', confine: true },
    legend: {
      type: 'scroll',
      top: 0,
      right: 4,
      itemWidth: 10,
      itemHeight: 10,
      data: seriesList.map((series) => series.label),
      textStyle: { color: '#334155', fontSize: 12, fontWeight: 650 },
      pageButtonPosition: 'end',
      pageIconColor: '#2196f3',
      pageIconInactiveColor: '#b7c5cf',
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: months,
      axisTick: { alignWithLabel: true },
      axisLine: { lineStyle: { color: '#cfd8e3' } },
      axisLabel: {
        color: '#64748b',
        hideOverlap: true,
        interval: monthLabelInterval,
        margin: 8,
        formatter: (value: string) => overviewAxisLabel(value),
      },
    },
    yAxis: {
      type: 'value',
      name: 'Work orders',
      nameTextStyle: { color: '#64748b', fontWeight: 700 },
      axisLabel: { color: '#64748b' },
      splitLine: { lineStyle: { color: '#e4ebf1' } },
    },
    series: [...labelBandRuleSeries, ...dividerSeries, ...lineSeries],
  }
}

function makeChartOption(data: CriticalTeamSheetResponse | null, viewMode: ChartViewMode = 'count'): EChartsOption {
  const rows = data?.rows ?? []
  const months = [...new Set(rows.map((row) => row.month_label))]
  const groups = [...new Set(rows.map((row) => row.group_name))]
  const lookup = new Map(rows.map((row) => [`${row.month_label}::${row.group_name}`, row.count_value]))
  const groupColumn = data?.sheet.group_column
  const isPercentMode = viewMode === 'percent'
  const monthTotals = new Map(
    months.map((month) => [
      month,
      groups.reduce((sum, group) => sum + (lookup.get(`${month}::${group}`) ?? 0), 0),
    ]),
  )
  const chartLookup = new Map<string, number>()
  for (const month of months) {
    const monthTotal = monthTotals.get(month) ?? 0
    for (const group of groups) {
      const rawValue = lookup.get(`${month}::${group}`) ?? 0
      chartLookup.set(`${month}::${group}`, isPercentMode && monthTotal > 0 ? (rawValue / monthTotal) * 100 : rawValue)
    }
  }
  const monthBuckets = months.map(parseMonthBucket)
  const quarterLabelGroups = periodLabelGroups(
    monthBuckets,
    (bucket) => `${bucket.year}-${bucket.quarter}`,
    (bucket) => bucket.quarter,
  )
  const yearLabelGroups = periodLabelGroups(
    monthBuckets,
    (bucket) => bucket.year,
    (bucket) => bucket.year,
  )
  const monthLabelInterval = months.length > 30 ? 1 : 0
  const legendTopSpace = groups.length > 5 ? 62 : groups.length > 2 ? 52 : 44
  const maxMonthTotal = Math.max(
    0,
    ...months.map((month) => monthTotals.get(month) ?? 0),
  )
  const maxChartValue = isPercentMode ? 100 : maxMonthTotal
  const boundaryLines = chartBoundaryLines(monthBuckets, maxChartValue)
  const barSegmentLabels = chartBarSegmentLabels(
    months,
    groups,
    chartLookup,
    groupColumn,
    (value, month, group) => (isPercentMode ? formatPercent(value) : formatNumber(lookup.get(`${month}::${group}`) ?? 0)),
  )
  const labelBandRuleSeries: CustomSeriesOption[] =
    months.length > 0
      ? [
          {
            type: 'custom',
            name: 'Period label row rules',
            coordinateSystem: 'cartesian2d',
            xAxisIndex: 0,
            yAxisIndex: 0,
            silent: true,
            clip: false,
            z: 1,
            data: [[0]],
            renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
              const coordSys = params.coordSys as unknown as { x: number; y: number; width: number; height: number }
              const labelBandTop = coordSys.y + coordSys.height
              const lineColor = '#d7e0e8'
              const x1 = coordSys.x
              const x2 = coordSys.x + coordSys.width
              const labelX = (group: PeriodLabelGroup) => {
                const startX = api.coord([months[group.startIndex], 0])[0]
                const endX = api.coord([months[group.endIndex], 0])[0]
                return (startX + endX) / 2
              }

              return {
                type: 'group',
                children: [
                  ...[24, 46, 66].map((offset) => ({
                    type: 'line',
                    shape: {
                      x1,
                      y1: labelBandTop + offset,
                      x2,
                      y2: labelBandTop + offset,
                    },
                    style: {
                      stroke: lineColor,
                      lineWidth: 1,
                    },
                  })),
                  ...quarterLabelGroups.map((group) => ({
                    type: 'text',
                    style: {
                      text: group.label,
                      x: labelX(group),
                      y: labelBandTop + 35,
                      fill: '#475569',
                      font: '700 13px Inter, system-ui, sans-serif',
                      textAlign: 'center',
                      textVerticalAlign: 'middle',
                    },
                  })),
                  ...yearLabelGroups.map((group) => ({
                    type: 'text',
                    style: {
                      text: group.label,
                      x: labelX(group),
                      y: labelBandTop + 57,
                      fill: '#0f172a',
                      font: '800 13px Inter, system-ui, sans-serif',
                      textAlign: 'center',
                      textVerticalAlign: 'middle',
                    },
                  })),
                ],
              } as CustomSeriesRenderItemReturn
            },
          },
        ]
      : []
  const dividerSeries: CustomSeriesOption[] =
    boundaryLines.length > 0
      ? [
          {
            type: 'custom',
            name: 'Period dividers',
            coordinateSystem: 'cartesian2d',
            xAxisIndex: 0,
            yAxisIndex: 0,
            silent: true,
            clip: false,
            z: 1,
            data: boundaryLines.map((line) => [line.boundaryIndex, 0, line.yTop, line.isYearBoundary ? 1 : 0]),
            renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
              const coordSys = params.coordSys as unknown as { y: number; height: number }
              const boundaryIndex = Number(api.value(0))
              const previousCenterX = api.coord([months[boundaryIndex - 1], 0])[0]
              const nextCenterX = api.coord([months[boundaryIndex], 0])[0]
              const x = (previousCenterX + nextCenterX) / 2
              const isYearBoundary = api.value(3) === 1
              const labelBandTop = coordSys.y + coordSys.height
              const y0 = labelBandTop + (isYearBoundary ? 66 : 46)
              const y1 = coordSys.y

              return {
                type: 'line',
                shape: { x1: x, y1: y0, x2: x, y2: y1 },
                style: {
                  stroke: isYearBoundary ? '#64748b' : '#cfd8e3',
                  lineWidth: isYearBoundary ? 2 : 1,
                  lineDash: isYearBoundary ? undefined : [4, 3],
                },
              }
            },
          },
        ]
      : []
  const barLabelSeries: CustomSeriesOption[] =
    barSegmentLabels.length > 0
      ? [
          {
            type: 'custom',
            name: 'Bar value labels',
            coordinateSystem: 'cartesian2d',
            xAxisIndex: 0,
            yAxisIndex: 0,
            silent: true,
            z: 4,
            data: barSegmentLabels.map((_label, index) => [index]),
            renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
              const label = barSegmentLabels[Number(api.value(0))]
              if (!label) return null

              const month = months[label.monthIndex]
              const labelText = label.labelText
              const centerX = api.coord([month, 0])[0]
              const previousX =
                label.monthIndex > 0 ? api.coord([months[label.monthIndex - 1], 0])[0] : null
              const nextX =
                label.monthIndex < months.length - 1 ? api.coord([months[label.monthIndex + 1], 0])[0] : null
              const neighborDistances = [previousX, nextX]
                .filter((value): value is number => value !== null)
                .map((value) => Math.abs(value - centerX))
              const categoryWidth = Math.min(...neighborDistances, 70)
              const barWidth = Math.min(46, categoryWidth * 0.66)
              const yStart = api.coord([month, label.startValue])[1]
              const yEnd = api.coord([month, label.endValue])[1]
              const segmentHeight = Math.abs(yEnd - yStart)
              const estimatedTextWidth = labelText.length * 7 + 4

              if (segmentHeight < 16 || barWidth < estimatedTextWidth) {
                return null
              }

              return {
                type: 'text',
                style: {
                  text: labelText,
                  x: centerX,
                  y: (yStart + yEnd) / 2,
                  fill: readableLabelColor(label.color),
                  font: '650 12px Inter, system-ui, sans-serif',
                  textAlign: 'center',
                  textVerticalAlign: 'middle',
                },
              } as CustomSeriesRenderItemReturn
            },
          },
        ]
      : []
  const barSeries: BarSeriesOption[] = groups.map((group, index) => ({
    name: group,
    type: 'bar',
    stack: 'total',
    barMaxWidth: 46,
    barCategoryGap: '34%',
    xAxisIndex: 0,
    z: 2,
    emphasis: { focus: 'series' },
    itemStyle: { color: colorForGroup(group, groupColumn, index) },
    data: months.map((month) => {
      const rawValue = lookup.get(`${month}::${group}`) ?? 0
      const chartValue = chartLookup.get(`${month}::${group}`) ?? 0

      return isPercentMode ? { value: chartValue, rawValue, percent: chartValue } : rawValue
    }),
  }))
  const tooltipFormatter = (params: unknown) => {
    const items = (Array.isArray(params) ? params : [params]) as Array<{
      axisValue?: string
      axisValueLabel?: string
      data?: unknown
      marker?: string
      seriesName?: string
      seriesType?: string
      value?: unknown
    }>
    const barItems = items.filter((item) => item.seriesType === 'bar')
    const firstItem = barItems[0] ?? items[0]
    const month = String(firstItem?.axisValue ?? '')
    const title = String(firstItem?.axisValueLabel ?? monthAxisLabel(month))
    const lines = barItems.map((item) => {
      const dataItem = item.data && typeof item.data === 'object' ? (item.data as Record<string, unknown>) : {}
      const rawValue = Number(isPercentMode ? dataItem.rawValue : item.value) || 0
      const percentValue =
        Number(isPercentMode ? dataItem.percent : chartLookup.get(`${month}::${item.seriesName ?? ''}`)) || 0
      const valueLabel = isPercentMode
        ? `${formatPercent(percentValue)} (${formatNumber(rawValue)})`
        : formatNumber(rawValue)

      return `${item.marker ?? ''}${escapeXml(item.seriesName ?? '')}: <strong>${valueLabel}</strong>`
    })

    return [`<strong>${escapeXml(title)}</strong>`, ...lines].join('<br />')
  }

  return {
    color: groups.map((group, index) => colorForGroup(group, groupColumn, index)),
    animationDuration: 220,
    grid: { top: legendTopSpace, right: 24, bottom: 72, left: 46, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, formatter: tooltipFormatter },
    legend: {
      type: 'scroll',
      top: 0,
      right: 4,
      width: '72%',
      itemWidth: 10,
      itemHeight: 10,
      data: groups,
      textStyle: { color: '#334155', fontSize: 12 },
      pageButtonPosition: 'end',
      pageIconColor: '#155e75',
      pageIconInactiveColor: '#b7c5cf',
    },
    xAxis: [
      {
        type: 'category',
        data: months,
        axisTick: { alignWithLabel: true },
        axisLine: { lineStyle: { color: '#cfd8e3' } },
        axisLabel: {
          interval: monthLabelInterval,
          rotate: 0,
          hideOverlap: true,
          margin: 8,
          color: '#64748b',
          formatter: (value: string) => monthAxisLabel(value),
        },
      },
      {
        type: 'category',
        data: months,
        position: 'bottom',
        offset: 28,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category',
        data: months,
        position: 'bottom',
        offset: 50,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
    ],
    yAxis: {
      type: 'value',
      name: isPercentMode ? 'Share of work orders' : 'Work orders',
      max: isPercentMode ? 100 : undefined,
      nameTextStyle: { color: '#64748b', fontWeight: 700 },
      axisLabel: {
        color: '#64748b',
        formatter: isPercentMode ? '{value}%' : undefined,
      },
      splitLine: { lineStyle: { color: '#e4ebf1' } },
    },
    series: [...labelBandRuleSeries, ...dividerSeries, ...barSeries, ...barLabelSeries],
  }
}

function pivotRows(data: CriticalTeamSheetResponse | null) {
  const rows = data?.rows ?? []
  const months = [...new Set(rows.map((row) => row.month_label))]
  const groups = [...new Set(rows.map((row) => row.group_name))]
  const lookup = new Map(rows.map((row) => [`${row.group_name}::${row.month_label}`, row.count_value]))
  const pivotGroups: PivotRow[] = groups.map((group) => {
    const values = months.map((month) => lookup.get(`${group}::${month}`) ?? 0)
    return {
      group,
      total: values.reduce((sum, value) => sum + value, 0),
      values,
    }
  })
  const grandValues = months.map((_month, index) =>
    pivotGroups.reduce((sum, group) => sum + group.values[index], 0),
  )

  return {
    months,
    groups: pivotGroups,
    grandValues,
    grandTotal: grandValues.reduce((sum, value) => sum + value, 0),
  }
}

function pivotMonthSortKey(month: string): PivotSortKey {
  return `month:${month}`
}

function pivotSortAria(sort: PivotSortState | null, key: PivotSortKey) {
  if (sort?.key !== key) return 'none'
  return sort.direction === 'asc' ? 'ascending' : 'descending'
}

function pivotSortValue(row: PivotRow, months: string[], key: PivotSortKey) {
  if (key === 'group') return row.group.toLocaleLowerCase()
  if (key === 'total') return row.total

  const month = key.slice('month:'.length)
  const index = months.indexOf(month)
  return index >= 0 ? row.values[index] : 0
}

function sortPivotGroups(groups: PivotRow[], months: string[], sort: PivotSortState | null) {
  if (!sort) return groups

  return groups
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftValue = pivotSortValue(left.row, months, sort.key)
      const rightValue = pivotSortValue(right.row, months, sort.key)
      const direction = sort.direction === 'asc' ? 1 : -1
      let comparison = 0

      if (typeof leftValue === 'string' || typeof rightValue === 'string') {
        comparison = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true })
      } else {
        comparison = leftValue - rightValue
      }

      if (comparison !== 0) return comparison * direction
      return left.index - right.index
    })
    .map((item) => item.row)
}

function pivotHeaderGroups(months: string[], level: 'year' | 'quarter') {
  const groups: PeriodLabelGroup[] = []
  let activeKey = ''
  let activeLabel = ''
  let activeIsDate = false
  let startIndex = -1

  months.forEach((month, index) => {
    const bucket = parseMonthBucket(month)
    const isDate = Boolean(bucket)
    const nextKey = bucket
      ? level === 'year'
        ? bucket.year
        : `${bucket.year}-${bucket.quarter}`
      : `undated-${month}`
    const nextLabel = bucket ? (level === 'year' ? bucket.year : bucket.quarter) : labelForValue(month)

    if (startIndex < 0) {
      activeKey = nextKey
      activeLabel = nextLabel
      activeIsDate = isDate
      startIndex = index
      return
    }

    if (activeKey !== nextKey) {
      groups.push({ label: activeLabel, startIndex, endIndex: index - 1, isDate: activeIsDate })
      activeKey = nextKey
      activeLabel = nextLabel
      activeIsDate = isDate
      startIndex = index
    }
  })

  if (startIndex >= 0) {
    groups.push({ label: activeLabel, startIndex, endIndex: months.length - 1, isDate: activeIsDate })
  }

  return groups
}

function pivotMonthLabel(month: string) {
  const bucket = parseMonthBucket(month)
  return bucket ? MONTH_NAMES[bucket.month - 1] : labelForValue(month)
}

function pivotBoundaryClass(months: string[], index: number) {
  if (index <= 0) return undefined

  const previous = parseMonthBucket(months[index - 1])
  const current = parseMonthBucket(months[index])
  if (!previous || !current) {
    return months[index - 1] === months[index] ? undefined : 'period-start'
  }
  if (previous.year !== current.year) {
    return 'period-start year-start'
  }
  if (previous.quarter !== current.quarter) {
    return 'period-start'
  }
  return undefined
}

function createPivotXlsx(title: string, data: CriticalTeamSheetResponse | null, sort: PivotSortState | null = null) {
  const pivot = pivotRows(data)
  const sortedGroups = sortPivotGroups(pivot.groups, pivot.months, sort)
  const groupColumnLabel = data?.sheet.group_column === 'wo_closed_by' ? 'Closed By' : 'Submit To'
  const yearGroups = pivotHeaderGroups(pivot.months, 'year')
  const quarterGroups = pivotHeaderGroups(pivot.months, 'quarter')
  const totalColumnIndex = pivot.months.length + 1
  const lastRowIndex = Math.max(3, pivot.groups.length + 4)
  const lastCell = `${columnLetter(totalColumnIndex)}${lastRowIndex}`
  const mergeRefs = [
    'A1:A3',
    `${columnLetter(totalColumnIndex)}1:${columnLetter(totalColumnIndex)}3`,
    ...yearGroups
      .filter((group) => group.endIndex > group.startIndex || !group.isDate)
      .map((group) =>
        group.isDate
          ? `${columnLetter(group.startIndex + 1)}1:${columnLetter(group.endIndex + 1)}1`
          : `${columnLetter(group.startIndex + 1)}1:${columnLetter(group.endIndex + 1)}3`,
      ),
    ...quarterGroups
      .filter((group) => group.isDate && group.endIndex > group.startIndex)
      .map((group) => `${columnLetter(group.startIndex + 1)}2:${columnLetter(group.endIndex + 1)}2`),
  ]
  const yearCells = [
    xlsxTextCell(0, 1, groupColumnLabel),
    ...yearGroups.map((group) => xlsxTextCell(group.startIndex + 1, 1, group.label)),
    xlsxTextCell(totalColumnIndex, 1, 'Grand Total'),
  ].join('')
  const quarterCells = quarterGroups
    .filter((group) => group.isDate)
    .map((group) => xlsxTextCell(group.startIndex + 1, 2, group.label))
    .join('')
  const monthCells = pivot.months
    .map((month, index) => parseMonthBucket(month) ? xlsxTextCell(index + 1, 3, pivotMonthLabel(month)) : '')
    .join('')
  const bodyRows = sortedGroups
    .map((row, rowIndex) => {
      const sheetRowIndex = rowIndex + 4
      const cells = [
        xlsxTextCell(0, sheetRowIndex, row.group),
        ...row.values.map((value, index) => xlsxNumberCell(index + 1, sheetRowIndex, value)),
        xlsxNumberCell(totalColumnIndex, sheetRowIndex, row.total),
      ].join('')
      return `<row r="${sheetRowIndex}">${cells}</row>`
    })
    .join('')
  const totalRowIndex = pivot.groups.length + 4
  const totalCells = [
    xlsxTextCell(0, totalRowIndex, 'Grand Total'),
    ...pivot.grandValues.map((value, index) => xlsxNumberCell(index + 1, totalRowIndex, value)),
    xlsxNumberCell(totalColumnIndex, totalRowIndex, pivot.grandTotal),
  ].join('')
  const mergeCells = mergeRefs.length
    ? `<mergeCells count="${mergeRefs.length}">${mergeRefs.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : ''
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetData>
    <row r="1">${yearCells}</row>
    <row r="2">${quarterCells}</row>
    <row r="3">${monthCells}</row>
    ${bodyRows}
    <row r="${totalRowIndex}">${totalCells}</row>
  </sheetData>
  ${mergeCells}
</worksheet>`

  return worksheetPackage(title, worksheet)
}

function downloadPivotTable(title: string, data: CriticalTeamSheetResponse | null, sort: PivotSortState | null = null) {
  const workbook = createPivotXlsx(title, data, sort)
  const blob = new Blob([workbook], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'table'
  link.href = url
  link.download = `${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function CriticalTeamDashboard() {
  const [selectedSheetId, setSelectedSheetId] = useState('overview')
  const [filters, setFilters] = useState<CriticalTeamFilters>(INITIAL_FILTERS)
  const [overviewFilters, setOverviewFilters] = useState<CriticalTeamOverviewFilters>(
    createDefaultOverviewFilters,
  )
  const [source, setSource] = useState<CriticalTeamSourceResponse | null>(null)
  const [summary, setSummary] = useState<CriticalTeamSummaryResponse | null>(null)
  const [overviewData, setOverviewData] = useState<CriticalTeamOverviewResponse | null>(null)
  const [options, setOptions] = useState<CriticalTeamFilterOptionsResponse | null>(null)
  const [sheetData, setSheetData] = useState<CriticalTeamSheetResponse | null>(null)
  const [details, setDetails] = useState<CriticalTeamWorkordersResponse | null>(null)
  const [detailColumnFilters, setDetailColumnFilters] = useState<DetailColumnFilters>(
    createEmptyDetailColumnFilters,
  )
  const [detailPageSize, setDetailPageSize] = useState(50)
  const [detailPage, setDetailPage] = useState(1)
  const [detailSort, setDetailSort] = useState<DetailSortState>(DEFAULT_DETAIL_SORT)
  const [exportingDetails, setExportingDetails] = useState(false)
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [loadingSheet, setLoadingSheet] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedSheet = SHEETS.find((sheet) => sheet.id === selectedSheetId) ?? SHEETS[1]
  const sheetConfig = source?.sheets[selectedSheet.id]

  useEffect(() => {
    const className = 'critical-team-overview-active'
    const isOverview = selectedSheet.kind === 'overview'

    document.documentElement.classList.toggle(className, isOverview)
    document.body.classList.toggle(className, isOverview)

    return () => {
      document.documentElement.classList.remove(className)
      document.body.classList.remove(className)
    }
  }, [selectedSheet.kind])

  useEffect(() => {
    let cancelled = false
    setLoadingMeta(true)
    Promise.all([
      fetchCriticalTeamSource(),
      fetchCriticalTeamSummary(),
      fetchCriticalTeamFilterOptions(),
    ])
      .then(([sourceResponse, summaryResponse, optionsResponse]) => {
        if (cancelled) return
        setSource(sourceResponse)
        setSummary(summaryResponse)
        setOptions(optionsResponse)
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : String(requestError))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    setLoadingSheet(true)

    const request =
      selectedSheet.kind === 'overview'
        ? fetchCriticalTeamOverview(overviewFilters).then((response) => {
            setOverviewData(response)
            setSheetData(null)
            setDetails(null)
          })
        : selectedSheet.kind === 'details'
          ? fetchCriticalTeamWorkorders(
              filters,
              detailPageSize,
              (detailPage - 1) * detailPageSize,
              detailColumnFilters,
              {
                sortBy: detailSort.column,
                sortDir: detailSort.direction,
              },
            ).then((response) => {
              setDetails(response)
              setSheetData(null)
              setOverviewData(null)
            })
          : fetchCriticalTeamSheet(selectedSheet.id, filters).then((response) => {
              setSheetData(response)
              setDetails(null)
              setOverviewData(null)
            })

    request
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : String(requestError))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSheet(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedSheet, overviewFilters, filters, detailColumnFilters, detailPage, detailPageSize, detailSort])

  useEffect(() => {
    if (selectedSheet.kind !== 'details' || !details) return
    const pageCount = Math.max(1, Math.ceil(details.total / detailPageSize))
    if (detailPage > pageCount) {
      setDetailPage(pageCount)
    }
  }, [selectedSheet.kind, details, detailPage, detailPageSize])

  const sheetGroups = useMemo(() => {
    return SHEETS.reduce<Record<string, SheetDefinition[]>>((groups, sheet) => {
      groups[sheet.category] = [...(groups[sheet.category] ?? []), sheet]
      return groups
    }, {})
  }, [])

  function updateFilters(next: CriticalTeamFilters | ((current: CriticalTeamFilters) => CriticalTeamFilters)) {
    setDetailPage(1)
    setFilters(next)
  }

  function updateOverviewFilters(
    next: CriticalTeamOverviewFilters | ((current: CriticalTeamOverviewFilters) => CriticalTeamOverviewFilters),
  ) {
    setOverviewFilters(next)
  }

  function resetOverviewFilters() {
    setOverviewFilters(createDefaultOverviewFilters())
  }

  function resetFiltersForSheet() {
    setDetailPage(1)
    setDetailColumnFilters(createEmptyDetailColumnFilters())
    setFilters(INITIAL_FILTERS)
    resetOverviewFilters()
  }

  function updateDetailNumberFilter(column: DetailNumberColumnKey, next: Partial<DetailNumberFilter>) {
    setDetailPage(1)
    setDetailColumnFilters((current) => {
      const currentFilter = current.numbers[column]
      const nextFilter = { ...currentFilter, ...next }
      if (next.mode === 'any') {
        nextFilter.from = ''
        nextFilter.to = ''
      }
      if (next.mode === 'exact' || next.mode === 'greater' || next.mode === 'less') {
        nextFilter.to = ''
      }
      return {
        ...current,
        numbers: { ...current.numbers, [column]: nextFilter },
      }
    })
  }

  function updateDetailCategoryFilter(column: DetailCategoryColumnKey, values: string[]) {
    setDetailPage(1)
    setDetailColumnFilters((current) => ({
      ...current,
      categories: { ...current.categories, [column]: values },
    }))
  }

  function updateDetailDateFilter(column: DetailDateColumnKey, next: Partial<DetailDateFilter>) {
    setDetailPage(1)
    setDetailColumnFilters((current) => {
      const currentFilter = current.dates[column]
      const nextFilter = { ...currentFilter, ...next }
      if (next.mode === 'any') {
        nextFilter.from = ''
        nextFilter.to = ''
      }
      if (next.mode === 'exact' || next.mode === 'before' || next.mode === 'after') {
        nextFilter.to = ''
      }
      return {
        ...current,
        dates: { ...current.dates, [column]: nextFilter },
      }
    })
  }

  function clearDetailColumnFilters() {
    setDetailPage(1)
    setDetailColumnFilters(createEmptyDetailColumnFilters())
  }

  function updateDetailPageSize(value: number) {
    setDetailPage(1)
    setDetailPageSize(value)
  }

  function updateDetailSort(column: DetailColumnKey) {
    setDetailPage(1)
    setDetailSort((current) => {
      if (current.column === column) {
        return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { column, direction: 'asc' }
    })
  }

  async function downloadAllWorkOrderRows() {
    const totalRows = details?.total ?? 0
    if (totalRows <= 0 || exportingDetails) {
      return
    }

    setError(null)
    setExportingDetails(true)
    try {
      const batchSize = 1000
      const allRows: AssetRow[] = []
      let offset = 0
      let expectedTotal = totalRows

      while (offset < expectedTotal) {
        const response = await fetchCriticalTeamWorkorders(
          filters,
          Math.min(batchSize, Math.max(1, expectedTotal - offset)),
          offset,
          detailColumnFilters,
          {
            sortBy: detailSort.column,
            sortDir: detailSort.direction,
          },
        )
        expectedTotal = response.total
        allRows.push(...response.rows)
        if (response.rows.length === 0) {
          break
        }
        offset += response.rows.length
      }

      downloadWorkOrderGridRows(allRows)
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError))
    } finally {
      setExportingDetails(false)
    }
  }

  const shellClassName =
    selectedSheet.kind === 'overview'
      ? 'workbook-shell overview-mode'
      : selectedSheet.kind === 'details'
        ? 'workbook-shell detail-mode'
        : 'workbook-shell'

  return (
    <div className={shellClassName}>
      <aside className="left-nav">
        <div className="brand-block">
          <div className="brand-mark">
            <Gauge size={24} />
          </div>
          <div>
            <strong>Critical Team Dashboard</strong>
            <span>Cityworks work orders</span>
          </div>
        </div>

        <nav aria-label="Worksheets">
          {Object.entries(sheetGroups).map(([group, sheets]) => (
            <div className="nav-group" key={group}>
              <span>{group}</span>
              {sheets.map((sheet) => (
                <button
                  key={sheet.id}
                  className={selectedSheet.id === sheet.id ? 'active' : ''}
                  type="button"
                  onClick={() => {
                    setSelectedSheetId(sheet.id)
                    setDetailPage(1)
                    setDetailColumnFilters(createEmptyDetailColumnFilters())
                    setDetailSort(DEFAULT_DETAIL_SORT)
                    setFilters(INITIAL_FILTERS)
                    setOverviewFilters(createDefaultOverviewFilters())
                  }}
                >
                  {sheet.kind === 'chart' ? <BarChart3 size={16} /> : null}
                  {sheet.kind === 'table' ? <Table2 size={16} /> : null}
                  {sheet.kind === 'overview' ? <Database size={16} /> : null}
                  {sheet.kind === 'details' ? <ClipboardList size={16} /> : null}
                  <span>{sheet.title}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="sheet-canvas">
        {/*
              {selectedSheet.kind} · {sheetConfig?.date_key ?? 'source'}
        */}

        {error ? <div className="error-banner">{error}</div> : null}
        {loadingMeta || loadingSheet ? (
          <div className="loading-bar">
            {loadingMeta ? 'Loading workbook metadata' : 'Refreshing worksheet'}
          </div>
        ) : null}

        <SheetBody
          sheet={selectedSheet}
          sheetConfig={sheetConfig}
          summary={summary}
          overviewData={overviewData}
          sheetData={sheetData}
          details={details}
          detailColumnFilters={detailColumnFilters}
          detailPageSize={detailPageSize}
          detailPage={detailPage}
          detailSort={detailSort}
          exportingDetails={exportingDetails}
          filters={filters}
          overviewFilters={overviewFilters}
          options={options}
          onFiltersChange={updateFilters}
          onOverviewFiltersChange={updateOverviewFilters}
          onClearOverviewFilters={resetOverviewFilters}
          onClearFilters={resetFiltersForSheet}
          onDetailNumberFilterChange={updateDetailNumberFilter}
          onDetailCategoryFilterChange={updateDetailCategoryFilter}
          onDetailDateFilterChange={updateDetailDateFilter}
          onClearDetailColumnFilters={clearDetailColumnFilters}
          onDetailPageSizeChange={updateDetailPageSize}
          onDetailPageChange={setDetailPage}
          onDetailSortChange={updateDetailSort}
          onDownloadAllDetails={downloadAllWorkOrderRows}
        />
      </main>
    </div>
  )
}

function SheetBody({
  sheet,
  sheetConfig,
  summary,
  overviewData,
  sheetData,
  details,
  detailColumnFilters,
  detailPageSize,
  detailPage,
  detailSort,
  exportingDetails,
  filters,
  overviewFilters,
  options,
  onFiltersChange,
  onOverviewFiltersChange,
  onClearOverviewFilters,
  onClearFilters,
  onDetailNumberFilterChange,
  onDetailCategoryFilterChange,
  onDetailDateFilterChange,
  onClearDetailColumnFilters,
  onDetailPageSizeChange,
  onDetailPageChange,
  onDetailSortChange,
  onDownloadAllDetails,
}: {
  sheet: SheetDefinition
  sheetConfig: CriticalTeamSourceResponse['sheets'][string] | undefined
  summary: CriticalTeamSummaryResponse | null
  overviewData: CriticalTeamOverviewResponse | null
  sheetData: CriticalTeamSheetResponse | null
  details: CriticalTeamWorkordersResponse | null
  detailColumnFilters: DetailColumnFilters
  detailPageSize: number
  detailPage: number
  detailSort: DetailSortState
  exportingDetails: boolean
  filters: CriticalTeamFilters
  overviewFilters: CriticalTeamOverviewFilters
  options: CriticalTeamFilterOptionsResponse | null
  onFiltersChange: (next: CriticalTeamFilters | ((current: CriticalTeamFilters) => CriticalTeamFilters)) => void
  onOverviewFiltersChange: (
    next: CriticalTeamOverviewFilters | ((current: CriticalTeamOverviewFilters) => CriticalTeamOverviewFilters),
  ) => void
  onClearOverviewFilters: () => void
  onClearFilters: () => void
  onDetailNumberFilterChange: (column: DetailNumberColumnKey, next: Partial<DetailNumberFilter>) => void
  onDetailCategoryFilterChange: (column: DetailCategoryColumnKey, values: string[]) => void
  onDetailDateFilterChange: (column: DetailDateColumnKey, next: Partial<DetailDateFilter>) => void
  onClearDetailColumnFilters: () => void
  onDetailPageSizeChange: (value: number) => void
  onDetailPageChange: (page: number) => void
  onDetailSortChange: (column: DetailColumnKey) => void
  onDownloadAllDetails: () => void
}) {
  const chartRef = useRef<EChartHandle | null>(null)
  const [chartViewMode, setChartViewMode] = useState<ChartViewMode>('count')
  const filterAction =
    sheet.kind !== 'overview' && sheet.kind !== 'details' ? (
      <FloatingFilterButton
        sheet={sheet}
        sheetConfig={sheetConfig}
        filters={filters}
        options={options}
        onChange={onFiltersChange}
        onClear={onClearFilters}
      />
    ) : null

  if (sheet.kind === 'overview') {
    return (
      <Overview
        data={overviewData}
        fallbackSummary={summary}
        filters={overviewFilters}
        options={options}
        onFiltersChange={onOverviewFiltersChange}
        onClearFilters={onClearOverviewFilters}
      />
    )
  }

  if (sheet.kind === 'chart') {
    return (
      <section className="sheet-panel chart-panel">
        <PanelHeader
          icon={<BarChart3 size={18} />}
          title={sheet.title}
          description={sheet.description}
          actions={
            <>
              <ChartViewToggle value={chartViewMode} onChange={setChartViewMode} />
              <ChartExportButton chartRef={chartRef} title={sheet.title} />
              {filterAction}
            </>
          }
        />
        <EChart ref={chartRef} option={makeChartOption(sheetData, chartViewMode)} height="100%" />
      </section>
    )
  }

  if (sheet.kind === 'table') {
    return <PivotTable title={sheet.title} description={sheet.description} data={sheetData} filterAction={filterAction} />
  }

  return (
    <DetailTable
      details={details}
      columnFilters={detailColumnFilters}
      pageSize={detailPageSize}
      page={detailPage}
      sort={detailSort}
      exporting={exportingDetails}
      options={options}
      onNumberFilterChange={onDetailNumberFilterChange}
      onCategoryFilterChange={onDetailCategoryFilterChange}
      onDateFilterChange={onDetailDateFilterChange}
      onClearColumnFilters={onClearDetailColumnFilters}
      onPageSizeChange={onDetailPageSizeChange}
      onPageChange={onDetailPageChange}
      onSortChange={onDetailSortChange}
      onDownloadAllRows={onDownloadAllDetails}
    />
  )
}

function Overview({
  data,
  fallbackSummary,
  filters,
  options,
  onFiltersChange,
  onClearFilters,
}: {
  data: CriticalTeamOverviewResponse | null
  fallbackSummary: CriticalTeamSummaryResponse | null
  filters: CriticalTeamOverviewFilters
  options: CriticalTeamFilterOptionsResponse | null
  onFiltersChange: (
    next: CriticalTeamOverviewFilters | ((current: CriticalTeamOverviewFilters) => CriticalTeamOverviewFilters),
  ) => void
  onClearFilters: () => void
}) {
  const overviewMetrics = data?.metrics
  const totals = data?.totals
  const dateRangeLabel = overviewDateRangeLabel(filters, data)
  const totalProjects =
    totals?.all_time_started_projects ?? fallbackSummary?.workorder_count ?? fallbackSummary?.project_started
  const allTimeScheduledInspections = totals?.all_time_scheduled_inspections ?? totalProjects
  const percentDenominator = Math.max(1, allTimeScheduledInspections ?? 0)
  const metrics = [
    {
      label: 'Total Work Orders',
      value: totalProjects,
      totalValue: null,
      progressValue: totalProjects,
      icon: <ClipboardList size={20} />,
      tone: 'teal',
    },
    {
      label: 'Inspection Scheduled',
      value: overviewMetrics?.future_inspection_scheduled,
      totalValue: totals?.all_time_future_inspection_scheduled,
      progressValue: totals?.all_time_future_inspection_scheduled,
      icon: <CalendarCheck size={20} />,
      tone: 'blue',
    },
    {
      label: 'Inspection In Progress',
      value: overviewMetrics?.inspection_in_progress,
      totalValue: totals?.all_time_inspection_in_progress,
      progressValue: totals?.all_time_inspection_in_progress,
      icon: <ClipboardClock size={20} />,
      tone: 'slate',
    },
    {
      label: 'On Hold',
      value: overviewMetrics?.on_hold,
      totalValue: totals?.all_time_on_hold,
      progressValue: totals?.all_time_on_hold,
      icon: <CirclePause size={20} />,
      tone: 'violet',
    },
    {
      label: 'Ready For Review',
      value: overviewMetrics?.ready_for_review,
      totalValue: totals?.all_time_ready_for_review,
      progressValue: totals?.all_time_ready_for_review,
      icon: <ClipboardCheck size={20} />,
      tone: 'orange',
    },
    {
      label: 'Revisions Required',
      value: overviewMetrics?.revisions_required,
      totalValue: totals?.all_time_revisions_required,
      progressValue: totals?.all_time_revisions_required,
      icon: <FilePenLine size={20} />,
      tone: 'green',
    },
    {
      label: 'Review Complete',
      value: overviewMetrics?.review_complete,
      totalValue: totals?.all_time_review_complete,
      progressValue: totals?.all_time_review_complete,
      icon: <BadgeCheck size={20} />,
      tone: 'slate',
    },
  ]

  return (
    <div className="overview-layout">
      <section className="sheet-panel overview-panel">
        <PanelHeader
          icon={<LayoutDashboard size={18} />}
          title="Overview"
          meta={dateRangeLabel}
          actions={
            <OverviewFilterButton
              filters={filters}
              options={options}
              onChange={onFiltersChange}
              onClear={onClearFilters}
            />
          }
        />
        <div className="profile-grid overview-kpi-grid">
          {metrics.map((metric) => (
            <Kpi
              icon={metric.icon}
              key={metric.label}
              label={metric.label}
              tone={metric.tone}
              totalValue={metric.totalValue}
              value={metric.value}
              maxValue={percentDenominator}
              progressValue={metric.progressValue}
            />
          ))}
        </div>
        <div className="overview-trend-card">
          <PanelHeader
            icon={<ChartLine size={18} />}
            title="Trend"
            description="Monthly totals for project starts, inspection completions, report completions, and review completions."
          />
          <EChart option={makeOverviewTrendOption(data, filters)} height="100%" />
        </div>
      </section>
    </div>
  )
}

function OverviewFilterButton({
  filters,
  options,
  onChange,
  onClear,
}: {
  filters: CriticalTeamOverviewFilters
  options: CriticalTeamFilterOptionsResponse | null
  onChange: (
    next: CriticalTeamOverviewFilters | ((current: CriticalTeamOverviewFilters) => CriticalTeamOverviewFilters),
  ) => void
  onClear: () => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="floating-filter-button" type="button">
          <Filter size={14} />
          Filters
        </Button>
      </PopoverTrigger>
      <PopoverContent className="filter-popover-content" align="end">
        <OverviewFiltersPanel
          filters={filters}
          options={options}
          onChange={onChange}
          onClear={onClear}
        />
      </PopoverContent>
    </Popover>
  )
}

function OverviewFiltersPanel({
  filters,
  options,
  onChange,
  onClear,
}: {
  filters: CriticalTeamOverviewFilters
  options: CriticalTeamFilterOptionsResponse | null
  onChange: (
    next: CriticalTeamOverviewFilters | ((current: CriticalTeamOverviewFilters) => CriticalTeamOverviewFilters),
  ) => void
  onClear: () => void
}) {
  const datePresets = [
    { label: 'Recent 6 months', range: createRecentOverviewDateRange(6) },
    { label: 'Recent 1 year', range: createRecentOverviewDateRange(12) },
    { label: 'Recent 2 years', range: createRecentOverviewDateRange(24) },
  ]
  const isAllTime = !filters.dateFrom && !filters.dateTo

  return (
    <div className="filter-card">
      <div className="filter-title">
        <div>
          <Filter size={18} />
          <strong>Overview Filters</strong>
        </div>
      </div>

      <div className="filter-section overview-date-range-filter">
        <label>Date Range</label>
        <div className="overview-date-mode">
          {datePresets.map((preset) => {
            const isActive = filters.dateFrom === preset.range.dateFrom && filters.dateTo === preset.range.dateTo

            return (
              <button
                className={isActive ? 'active' : ''}
                key={preset.label}
                type="button"
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    dateFrom: preset.range.dateFrom,
                    dateTo: preset.range.dateTo,
                  }))
                }
              >
                {preset.label}
              </button>
            )
          })}
          <button
            className={isAllTime ? 'active' : ''}
            type="button"
            onClick={() => onChange((current) => ({ ...current, dateFrom: '', dateTo: '' }))}
          >
            All time
          </button>
        </div>
        <div className="overview-date-range">
          <MonthPicker
            label="Start month"
            value={dateToMonthPickerValue(filters.dateFrom)}
            onChange={(month) => onChange((current) => ({ ...current, dateFrom: monthStartDate(month) }))}
          />
          <MonthPicker
            label="End month"
            value={dateToMonthPickerValue(filters.dateTo)}
            onChange={(month) => onChange((current) => ({ ...current, dateTo: monthEndDate(month) }))}
          />
        </div>
      </div>

      <ChecklistFilter
        icon={<UserRound size={15} />}
        label="Submit To"
        values={options?.submit_to ?? []}
        selected={filters.submitTo}
        allLabel="All submitters"
        onChange={(submitTo) => onChange((current) => ({ ...current, submitTo }))}
      />

      <ChecklistFilter
        icon={<UserRound size={15} />}
        label="Closed By"
        values={options?.wo_closed_by ?? []}
        selected={filters.closedBy}
        allLabel="All reviewers"
        onChange={(closedBy) => onChange((current) => ({ ...current, closedBy }))}
      />

      <button className="clear-button" type="button" onClick={onClear}>
        Reset filters
      </button>
    </div>
  )
}

function ChartViewToggle({
  value,
  onChange,
}: {
  value: ChartViewMode
  onChange: (value: ChartViewMode) => void
}) {
  return (
    <div className="chart-view-toggle" aria-label="Chart view mode" role="group">
      <button
        className={value === 'count' ? 'active' : ''}
        type="button"
        aria-pressed={value === 'count'}
        onClick={() => onChange('count')}
      >
        Stacked count
      </button>
      <button
        className={value === 'percent' ? 'active' : ''}
        type="button"
        aria-pressed={value === 'percent'}
        onClick={() => onChange('percent')}
      >
        100% stacked
      </button>
    </div>
  )
}

function MonthPicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="month-picker-control">
      <span>{label}</span>
      <div>
        <CalendarDays size={14} />
        <input
          type="month"
          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </label>
  )
}

function FloatingFilterButton({
  sheet,
  sheetConfig,
  filters,
  options,
  onChange,
  onClear,
}: {
  sheet: SheetDefinition
  sheetConfig: CriticalTeamSourceResponse['sheets'][string] | undefined
  filters: CriticalTeamFilters
  options: CriticalTeamFilterOptionsResponse | null
  onChange: (next: CriticalTeamFilters | ((current: CriticalTeamFilters) => CriticalTeamFilters)) => void
  onClear: () => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="floating-filter-button" type="button">
          <Filter size={14} />
          Filters
        </Button>
      </PopoverTrigger>
      <PopoverContent className="filter-popover-content" align="end">
        <SheetFilters
          sheet={sheet}
          sheetConfig={sheetConfig}
          filters={filters}
          options={options}
          onChange={onChange}
          onClear={onClear}
        />
      </PopoverContent>
    </Popover>
  )
}

function ChartExportButton({
  chartRef,
  title,
}: {
  chartRef: RefObject<EChartHandle | null>
  title: string
}) {
  function exportChart(type: 'png' | 'jpg') {
    const dataUrl = chartRef.current?.exportImage(type, CHART_EXPORT_PIXEL_RATIO)
    if (!dataUrl) return

    downloadDataUrl(
      dataUrl,
      `${fileNameSlug(title)}-300dpi.${type}`,
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="chart-export-button" type="button">
          <Download size={14} />
          Export
        </Button>
      </PopoverTrigger>
      <PopoverContent className="chart-export-popover" align="end">
        <Button variant="ghost" size="sm" type="button" onClick={() => exportChart('png')}>
          PNG
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={() => exportChart('jpg')}>
          JPG
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function SheetFilters({
  sheet,
  sheetConfig,
  filters,
  options,
  onChange,
  onClear,
}: {
  sheet: SheetDefinition
  sheetConfig: CriticalTeamSourceResponse['sheets'][string] | undefined
  filters: CriticalTeamFilters
  options: CriticalTeamFilterOptionsResponse | null
  onChange: (next: CriticalTeamFilters | ((current: CriticalTeamFilters) => CriticalTeamFilters)) => void
  onClear: () => void
}) {
  const dateKey = sheetConfig?.date_key ?? sheet.dateKey
  const yearOptions = dateKey ? options?.years[dateKey] ?? [] : []
  const defaultYears = sheetConfig?.default_years ?? []
  const defaultStatuses = sheetConfig?.default_statuses ?? []
  const activeYears = filters.tableauDefaults ? defaultYears : filters.years
  const activeStatuses = filters.tableauDefaults && sheet.kind !== 'details' ? defaultStatuses : filters.statuses

  return (
    <div className="filter-card">
      <div className="filter-title">
        <div>
          <Filter size={18} />
          <strong>Sheet Filters</strong>
        </div>
      </div>

      {sheet.kind === 'details' ? (
        <div className="filter-section">
          <label htmlFor="workorder-search">Search</label>
          <div className="search-box">
            <Search size={16} />
            <input
              id="workorder-search"
              value={filters.search}
              onChange={(event) =>
                onChange((current) => ({ ...current, search: event.target.value }))
              }
              placeholder="Work order, facility, person"
            />
          </div>
        </div>
      ) : null}

      {yearOptions.length > 0 && sheet.kind !== 'details' && sheet.kind !== 'overview' ? (
        <CheckboxGroup
          icon={<CalendarDays size={15} />}
          label={dateKey?.replaceAll('_', ' ') ?? 'Year'}
          values={yearOptions}
          selected={activeYears}
          onChange={(nextYears) =>
            onChange((current) => ({ ...current, tableauDefaults: false, years: nextYears }))
          }
        />
      ) : null}

      {sheet.groupColumn === 'submit_to' || sheet.kind === 'details' ? (
        <ChecklistFilter
          icon={<UserRound size={15} />}
          label="Submit To"
          values={options?.submit_to ?? []}
          selected={filters.submitTo}
          allLabel="All submitters"
          onChange={(selected) => onChange((current) => ({ ...current, submitTo: selected }))}
        />
      ) : null}

      {sheet.groupColumn === 'wo_closed_by' || sheet.kind === 'details' ? (
        <SelectFilter
          icon={<UserRound size={15} />}
          label="Closed By"
          value={filters.closedBy}
          options={options?.wo_closed_by ?? []}
          emptyLabel="All reviewers"
          onChange={(value) => onChange((current) => ({ ...current, closedBy: value }))}
        />
      ) : null}

      {sheet.statusFilter || sheet.kind === 'details' ? (
        <CheckboxGroup
          label="Critical Team Status"
          values={options?.critical_team_status ?? []}
          selected={activeStatuses}
          onChange={(nextStatuses) =>
            onChange((current) => ({
              ...current,
              tableauDefaults: sheet.kind === 'details' ? current.tableauDefaults : false,
              statuses: nextStatuses,
            }))
          }
        />
      ) : null}

      <button className="clear-button" type="button" onClick={onClear}>
        Reset filters
      </button>
    </div>
  )
}

function Kpi({
  icon,
  label,
  maxValue,
  progressValue,
  tone,
  totalValue,
  value,
}: {
  icon: ReactNode
  label: string
  maxValue: number
  progressValue?: number | null
  tone: string
  totalValue?: number | null
  value: number | null | undefined
}) {
  const numericValue = value ?? 0
  const numericProgressValue = progressValue ?? numericValue
  const progress = Math.max(0, Math.min(100, (numericProgressValue / maxValue) * 100))
  const progressDegrees = progress * 3.6

  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-copy">
        <span>{label}</span>
        <div className="kpi-value">
          <strong>{formatNumber(value)}</strong>
          {totalValue !== null && totalValue !== undefined ? (
            <small>/ {formatNumber(totalValue)}</small>
          ) : null}
        </div>
      </div>
      <div
        className="kpi-progress-ring"
        style={{
          background: `conic-gradient(var(--kpi-color) ${progressDegrees}deg, rgba(221, 230, 241, 0.86) 0deg)`,
        }}
        aria-label={`${Math.round(progress)} percent of all-time scheduled inspections`}
      >
        <span>{Math.round(progress)}%</span>
      </div>
    </div>
  )
}

function PanelHeader({
  icon,
  title,
  description,
  meta,
  actions,
}: {
  icon: ReactNode
  title: string
  description?: string
  meta?: string
  actions?: ReactNode
}) {
  return (
    <div className="panel-header">
      <div>
        {icon}
        <div className="panel-title-copy">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      {meta || actions ? (
        <div className="panel-header-actions">
          {meta ? <span className="panel-header-meta">{meta}</span> : null}
          {actions}
        </div>
      ) : null}
    </div>
  )
}

function CheckboxGroup({
  icon,
  label,
  values,
  selected,
  disabled = false,
  onChange,
}: {
  icon?: ReactNode
  label: string
  values: string[]
  selected: string[]
  disabled?: boolean
  onChange: (selected: string[]) => void
}) {
  function toggle(value: string) {
    if (disabled) return
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])
  }

  return (
    <div className="filter-section">
      <label>
        {icon}
        {label}
      </label>
      <div className="check-grid">
        {values.map((value) => (
          <button
            key={value}
            className={selected.includes(value) ? 'active' : ''}
            disabled={disabled}
            type="button"
            onClick={() => toggle(value)}
          >
            {labelForValue(value)}
          </button>
        ))}
      </div>
    </div>
  )
}

function ChecklistFilter({
  icon,
  label,
  values,
  selected,
  allLabel,
  onChange,
}: {
  icon?: ReactNode
  label: string
  values: string[]
  selected: string[]
  allLabel: string
  onChange: (selected: string[]) => void
}) {
  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])
  }

  return (
    <div className="filter-section checklist-filter">
      <label>
        {icon}
        {label}
      </label>
      <div className="checklist-options">
        <label className="checklist-option">
          <Checkbox checked={selected.length === 0} onCheckedChange={() => onChange([])} />
          <span>{allLabel}</span>
        </label>
        {values.map((value) => (
          <label className="checklist-option" key={value}>
            <Checkbox checked={selected.includes(value)} onCheckedChange={() => toggle(value)} />
            <span>{labelForValue(value)}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function SelectFilter({
  icon,
  label,
  value,
  options,
  emptyLabel,
  onChange,
}: {
  icon?: ReactNode
  label: string
  value: string
  options: string[]
  emptyLabel: string
  onChange: (value: string) => void
}) {
  return (
    <div className="filter-section">
      <label>{label}</label>
      <div className={icon ? 'input-with-icon' : undefined}>
        {icon}
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{emptyLabel}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function PivotTable({
  title,
  description,
  data,
  filterAction,
}: {
  title: string
  description: string
  data: CriticalTeamSheetResponse | null
  filterAction?: ReactNode
}) {
  const pivot = pivotRows(data)
  const yearGroups = pivotHeaderGroups(pivot.months, 'year')
  const quarterGroups = pivotHeaderGroups(pivot.months, 'quarter')
  const groupColumnLabel = data?.sheet.group_column === 'wo_closed_by' ? 'Closed By' : 'Submit To'
  const [pivotSort, setPivotSort] = useState<PivotSortState | null>(null)
  const [selectedPivotRow, setSelectedPivotRow] = useState<string | null>(null)
  const sortedGroups = sortPivotGroups(pivot.groups, pivot.months, pivotSort)

  useEffect(() => {
    setPivotSort(null)
    setSelectedPivotRow(null)
  }, [title])

  function handleSelectableRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, rowKey: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelectedPivotRow(rowKey)
    }
  }

  function updatePivotSort(key: PivotSortKey) {
    setPivotSort((current) => {
      if (current?.key === key) {
        return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key, direction: 'asc' }
    })
  }

  function renderPivotSortButton(label: string, key: PivotSortKey) {
    const active = pivotSort?.key === key
    return (
      <button
        className={active ? 'sort-button matrix-sort-button active' : 'sort-button matrix-sort-button'}
        type="button"
        title={`Sort by ${label}`}
        onClick={() => updatePivotSort(key)}
      >
        <span>{label}</span>
        {active ? (
          pivotSort.direction === 'asc' ? (
            <ArrowUp size={13} />
          ) : (
            <ArrowDown size={13} />
          )
        ) : (
          <ArrowDownUp size={13} />
        )}
      </button>
    )
  }

  return (
    <section className="sheet-panel table-panel">
      <PanelHeader
        icon={<Table2 size={18} />}
        title={title}
        description={description}
        meta={`${formatNumber(pivot.groups.length)} rows | ${formatNumber(pivot.months.length)} months`}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="table-download-button"
              type="button"
              disabled={pivot.groups.length === 0}
              onClick={() => downloadPivotTable(title, data, pivotSort)}
            >
              <Download size={14} />
              Download Excel
            </Button>
            {filterAction}
          </>
        }
      />
      <div className="table-wrap">
        <table className="matrix-table">
          <colgroup>
            <col className="matrix-row-label-col" />
            {pivot.months.map((month, index) => (
              <col className={pivotBoundaryClass(pivot.months, index)} key={month} />
            ))}
            <col className="matrix-total-col" />
          </colgroup>
          <thead>
            <tr>
              <th className="matrix-group-header" rowSpan={3} aria-sort={pivotSortAria(pivotSort, 'group')}>
                {renderPivotSortButton(groupColumnLabel, 'group')}
              </th>
              {yearGroups.map((group) => (
                <th
                  className={group.isDate ? 'period-header year-header' : 'period-header no-date-header'}
                  key={`${group.label}-${group.startIndex}`}
                  colSpan={group.endIndex - group.startIndex + 1}
                  rowSpan={group.isDate ? undefined : 3}
                  aria-sort={
                    group.isDate ? undefined : pivotSortAria(pivotSort, pivotMonthSortKey(pivot.months[group.startIndex]))
                  }
                >
                  {group.isDate
                    ? group.label
                    : renderPivotSortButton(group.label, pivotMonthSortKey(pivot.months[group.startIndex]))}
                </th>
              ))}
              <th className="matrix-total-header" rowSpan={3} aria-sort={pivotSortAria(pivotSort, 'total')}>
                {renderPivotSortButton('Grand Total', 'total')}
              </th>
            </tr>
            <tr>
              {quarterGroups.filter((group) => group.isDate).map((group) => (
                <th className="period-header quarter-header" key={`${group.label}-${group.startIndex}`} colSpan={group.endIndex - group.startIndex + 1}>
                  {group.label}
                </th>
              ))}
            </tr>
            <tr>
              {pivot.months.map((month, index) => parseMonthBucket(month) ? (
                <th
                  className={pivotBoundaryClass(pivot.months, index)}
                  key={month}
                  aria-sort={pivotSortAria(pivotSort, pivotMonthSortKey(month))}
                >
                  {renderPivotSortButton(pivotMonthLabel(month), pivotMonthSortKey(month))}
                </th>
              ) : null)}
            </tr>
          </thead>
          <tbody>
            {sortedGroups.map((row) => (
              <tr
                className={selectedPivotRow === row.group ? 'selected-row' : undefined}
                key={row.group}
                tabIndex={0}
                onClick={() => setSelectedPivotRow(row.group)}
                onKeyDown={(event) => handleSelectableRowKeyDown(event, row.group)}
              >
                <td>{row.group}</td>
                {row.values.map((value, index) => (
                  <td key={pivot.months[index]}>{value ? formatNumber(value) : ''}</td>
                ))}
                <td className="matrix-total-cell">{formatNumber(row.total)}</td>
              </tr>
            ))}
            <tr
              className={selectedPivotRow === '__grand_total__' ? 'grand-total-row selected-row' : 'grand-total-row'}
              tabIndex={0}
              onClick={() => setSelectedPivotRow('__grand_total__')}
              onKeyDown={(event) => handleSelectableRowKeyDown(event, '__grand_total__')}
            >
              <td>Grand Total</td>
              {pivot.grandValues.map((value, index) => (
                <td key={pivot.months[index]}>{value ? formatNumber(value) : ''}</td>
              ))}
              <td className="matrix-total-cell">{formatNumber(pivot.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function CalendarDatePicker({
  value,
  ariaLabel,
  onChange,
}: {
  value: string
  ariaLabel: string
  onChange: (value: string) => void
}) {
  const selectedDate = parseDatePickerValue(value)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="date-picker-trigger"
          type="button"
          aria-label={ariaLabel}
        >
          <CalendarDays size={14} />
          <span>{value || 'Select date'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selectedDate}
          captionLayout="dropdown"
          onSelect={(date) => {
            if (date) {
              onChange(formatDatePickerValue(date))
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function DateColumnFilter({
  label,
  filter,
  onChange,
}: {
  label: string
  filter: DetailDateFilter
  onChange: (next: Partial<DetailDateFilter>) => void
}) {
  return (
    <div className="date-filter-cell">
      <Select
        value={filter.mode}
        onValueChange={(value) => onChange({ mode: value as DetailDateFilterMode })}
      >
        <SelectTrigger size="sm" className="column-filter-select" aria-label={`${label} filter mode`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any date</SelectItem>
          <SelectItem value="exact">Exact date</SelectItem>
          <SelectItem value="between">Between</SelectItem>
          <SelectItem value="before">Earlier than</SelectItem>
          <SelectItem value="after">Later than</SelectItem>
        </SelectContent>
      </Select>
      {filter.mode !== 'any' ? (
        <CalendarDatePicker
          value={filter.from}
          ariaLabel={`${label} ${filter.mode === 'between' ? 'start date' : 'date'}`}
          onChange={(value) => onChange({ from: value })}
        />
      ) : null}
      {filter.mode === 'between' ? (
        <CalendarDatePicker
          value={filter.to}
          ariaLabel={`${label} end date`}
          onChange={(value) => onChange({ to: value })}
        />
      ) : null}
    </div>
  )
}

function NumberColumnFilter({
  label,
  filter,
  onChange,
}: {
  label: string
  filter: DetailNumberFilter
  onChange: (next: Partial<DetailNumberFilter>) => void
}) {
  function cleanNumber(value: string) {
    return value.replace(/\D/g, '')
  }

  return (
    <div className="number-filter-cell">
      <Select
        value={filter.mode}
        onValueChange={(value) => onChange({ mode: value as DetailNumberFilterMode })}
      >
        <SelectTrigger size="sm" className="column-filter-select" aria-label={`${label} filter mode`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any number</SelectItem>
          <SelectItem value="exact">Specific number</SelectItem>
          <SelectItem value="between">Between</SelectItem>
          <SelectItem value="greater">Greater than</SelectItem>
          <SelectItem value="less">Less than</SelectItem>
        </SelectContent>
      </Select>
      {filter.mode !== 'any' ? (
        <Input
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          className="number-filter-input"
          value={filter.from}
          aria-label={`${label} ${filter.mode === 'between' ? 'minimum' : 'number'}`}
          onChange={(event) => onChange({ from: cleanNumber(event.target.value) })}
        />
      ) : null}
      {filter.mode === 'between' ? (
        <Input
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          className="number-filter-input"
          value={filter.to}
          aria-label={`${label} maximum`}
          onChange={(event) => onChange({ to: cleanNumber(event.target.value) })}
        />
      ) : null}
    </div>
  )
}

function MultiSelectColumnFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (selected: string[]) => void
}) {
  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])
  }

  const summary = selected.length === 0 ? 'All' : selected.length === 1 ? labelForValue(selected[0]) : `${selected.length} selected`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="multi-filter-trigger"
          type="button"
          aria-label={`${label} filter`}
        >
          <span>{summary}</span>
          {selected.length > 0 ? (
            <Badge variant="secondary">{selected.length}</Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="multi-filter-popover" align="start">
        <div className="multi-filter-options">
          {options.length === 0 ? <span className="multi-filter-empty">No options</span> : null}
          {options.map((option) => (
            <label className="multi-filter-option" key={option}>
              <Checkbox
                checked={selected.includes(option)}
                onCheckedChange={() => toggle(option)}
              />
              <span>{labelForValue(option)}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function DetailTable({
  details,
  columnFilters,
  pageSize,
  page,
  sort,
  exporting,
  options,
  onNumberFilterChange,
  onCategoryFilterChange,
  onDateFilterChange,
  onClearColumnFilters,
  onPageSizeChange,
  onPageChange,
  onSortChange,
  onDownloadAllRows,
}: {
  details: CriticalTeamWorkordersResponse | null
  columnFilters: DetailColumnFilters
  pageSize: number
  page: number
  sort: DetailSortState
  exporting: boolean
  options: CriticalTeamFilterOptionsResponse | null
  onNumberFilterChange: (column: DetailNumberColumnKey, next: Partial<DetailNumberFilter>) => void
  onCategoryFilterChange: (column: DetailCategoryColumnKey, values: string[]) => void
  onDateFilterChange: (column: DetailDateColumnKey, next: Partial<DetailDateFilter>) => void
  onClearColumnFilters: () => void
  onPageSizeChange: (value: number) => void
  onPageChange: (page: number) => void
  onSortChange: (column: DetailColumnKey) => void
  onDownloadAllRows: () => void
}) {
  const total = details?.total ?? 0
  const rows = details?.rows ?? []
  const firstRecord = total === 0 ? 0 : (details?.offset ?? 0) + 1
  const lastRecord = total === 0 ? 0 : Math.min((details?.offset ?? 0) + rows.length, total)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const activeColumnFilters = hasActiveDetailFilters(columnFilters)
  const [selectedDetailRow, setSelectedDetailRow] = useState<string | null>(null)

  useEffect(() => {
    setSelectedDetailRow(null)
  }, [details?.offset, pageSize, sort.column, sort.direction, columnFilters])

  function moveToPage(nextPage: number) {
    onPageChange(Math.max(1, Math.min(pageCount, nextPage)))
  }

  function handleDetailRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, rowKey: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelectedDetailRow(rowKey)
    }
  }

  function renderColumnFilter(column: (typeof DETAIL_COLUMNS)[number]) {
    const columnKey = column.key
    if (isDetailNumberColumn(columnKey)) {
      return (
        <NumberColumnFilter
          label={column.label}
          filter={columnFilters.numbers[columnKey]}
          onChange={(next) => onNumberFilterChange(columnKey, next)}
        />
      )
    }
    if (isDetailCategoryColumn(columnKey)) {
      const categoryOptions: Record<DetailCategoryColumnKey, string[]> = {
        submit_to: options?.submit_to ?? [],
        wo_closed_by: options?.wo_closed_by ?? [],
        critical_team_status: options?.critical_team_status ?? [],
      }
      return (
        <MultiSelectColumnFilter
          label={column.label}
          options={categoryOptions[columnKey]}
          selected={columnFilters.categories[columnKey]}
          onChange={(selected) => onCategoryFilterChange(columnKey, selected)}
        />
      )
    }
    if (isDetailDateColumn(columnKey)) {
      return (
        <DateColumnFilter
          label={column.label}
          filter={columnFilters.dates[columnKey]}
          onChange={(next) => onDateFilterChange(columnKey, next)}
        />
      )
    }

    return null
  }

  return (
    <section className="sheet-panel table-panel detail-panel">
      <PanelHeader icon={<ClipboardList size={18} />} title="Work Order Detail" meta={`${formatNumber(details?.total)} rows`} />
      <div className="detail-toolbar">
        <div className="records-per-page">
          <span>Records per page</span>
          <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
            <SelectTrigger size="sm" className="page-size-select" aria-label="Records per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DETAIL_PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="detail-toolbar-actions">
          <span>
            {formatNumber(firstRecord)}-{formatNumber(lastRecord)} of {formatNumber(total)}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="export-button"
            type="button"
            disabled={total === 0 || exporting}
            onClick={onDownloadAllRows}
          >
            <Download size={14} />
            {exporting ? 'Preparing...' : 'Download Excel'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="clear-table-filters"
            type="button"
            disabled={!activeColumnFilters}
            onClick={onClearColumnFilters}
          >
            <X size={14} />
            Clear column filters
          </Button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="detail-table">
          <thead>
            <tr>
              {DETAIL_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  aria-sort={
                    sort.column === column.key
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    className={sort.column === column.key ? 'sort-button active' : 'sort-button'}
                    type="button"
                    onClick={() => onSortChange(column.key)}
                    title={`Sort by ${column.label}`}
                  >
                    <span>{column.label}</span>
                    {sort.column === column.key ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp size={13} />
                      ) : (
                        <ArrowDown size={13} />
                      )
                    ) : (
                      <ArrowDownUp size={13} />
                    )}
                  </button>
                </th>
              ))}
            </tr>
            <tr className="column-filter-row">
              {DETAIL_COLUMNS.map((column) => (
                <th key={column.key}>{renderColumnFilter(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const rowKey = `${row.workorder_id ?? `${details?.offset ?? 0}-${index}`}`
              return (
                <tr
                  className={selectedDetailRow === rowKey ? 'selected-row' : undefined}
                  key={rowKey}
                  tabIndex={0}
                  onClick={() => setSelectedDetailRow(rowKey)}
                  onKeyDown={(event) => handleDetailRowKeyDown(event, rowKey)}
                >
                  {DETAIL_COLUMNS.map((column) => (
                    <td key={column.key}>{valueText(row[column.key])}</td>
                  ))}
                </tr>
              )
            })}
            {rows.length === 0 ? (
              <tr>
                <td className="empty-row" colSpan={DETAIL_COLUMNS.length}>
                  No work orders match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="pagination" aria-label="Work order pagination">
        <span>
          Page {formatNumber(total === 0 ? 1 : page)} of {formatNumber(pageCount)}
        </span>
        <div className="pagination-actions">
          <Button variant="outline" size="icon-sm" type="button" title="First page" aria-label="First page" disabled={page <= 1} onClick={() => moveToPage(1)}>
            <ChevronsLeft size={16} />
          </Button>
          <Button variant="outline" size="icon-sm" type="button" title="Previous page" aria-label="Previous page" disabled={page <= 1} onClick={() => moveToPage(page - 1)}>
            <ChevronLeft size={16} />
          </Button>
          <Button variant="outline" size="icon-sm" type="button" title="Next page" aria-label="Next page" disabled={page >= pageCount || total === 0} onClick={() => moveToPage(page + 1)}>
            <ChevronRight size={16} />
          </Button>
          <Button variant="outline" size="icon-sm" type="button" title="Last page" aria-label="Last page" disabled={page >= pageCount || total === 0} onClick={() => moveToPage(pageCount)}>
            <ChevronsRight size={16} />
          </Button>
        </div>
      </div>
    </section>
  )
}

export default CriticalTeamDashboard
