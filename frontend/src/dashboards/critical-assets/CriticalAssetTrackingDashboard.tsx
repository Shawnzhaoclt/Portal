import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import type { EChartsOption } from 'echarts'
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  BarChart3,
  Download,
  Filter,
  Gauge,
  Search,
  Table2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import '../critical-team/CriticalTeamDashboard.css'
import './CriticalAssetTrackingDashboard.css'
import { EChart, type EChartHandle } from '../../EChart'
import { Button } from '@/components/ui/button'
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
  fetchAggregates,
  fetchFilterOptions,
  fetchHistory,
  fetchTable,
} from './api'
import type {
  AggregateRow,
  AggregatesResponse,
  AssetRow,
  BooleanFilterValue,
  CellValue,
  FilterOptionsResponse,
  FilterState,
  HistoryResponse,
  MetricKey,
  SourceKey,
  TableColumnFilters,
  TableResponse,
} from './types'

type AssetSheetKind = 'aggregate' | 'history' | 'table'
type SortDirection = 'asc' | 'desc'
type TableSortState = {
  column: string
  direction: SortDirection
}
type ChartMeasure = 'avg_value' | 'median_value' | 'max_value' | 'sum_value'
type FilterUpdater = (next: FilterState | ((current: FilterState) => FilterState)) => void
type AssetFilterPanelMode = 'full' | 'history-graph-both' | 'history-table-both' | 'history-table-pipes'

type AssetSheet = {
  id: string
  title: string
  workbookTitle?: string
  category: 'Facility Aggregates' | 'History'
  description: string
  kind: AssetSheetKind
  source?: SourceKey
  metric?: MetricKey
  icon: LucideIcon
}

const TABLE_PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500]
const CHART_EXPORT_PIXEL_RATIO = 300 / 96

const NUMERIC_FILTER_KEYS = [
  'risk',
  'condition_risk',
  'flood_risk',
  'clog_risk',
  'risk_delta',
  'condition_delta',
  'flood_delta',
  'clog_delta',
  'risk_delta_sum',
  'condition_delta_sum',
  'flood_delta_sum',
  'clog_delta_sum',
  'pipe_size',
  'inspection_count',
]

const HISTORY_GRAPH_DELTA_FILTERS = [
  {
    column: 'COND_RISK_DELTA_SUM',
    defaultMax: 123.82499999999999,
    defaultMin: 0,
    label: 'COND_RISK_DELTA_SUM',
    rangeKey: 'condition_delta_sum',
  },
  {
    column: 'RISK_DELTA_SUM',
    defaultMax: 80.614999999999995,
    defaultMin: 0,
    label: 'RISK_DELTA_SUM',
    rangeKey: 'risk_delta_sum',
  },
  {
    column: 'FLOOD_RISK_DELTA_SUM',
    defaultMax: 88,
    defaultMin: 0,
    label: 'FLOOD_RISK_DELTA_SUM',
    rangeKey: 'flood_delta_sum',
  },
  {
    column: 'CLOG_RISK_DELTA_SUM',
    defaultMax: 162.75,
    defaultMin: 0,
    label: 'CLOG_RISK_DELTA_SUM',
    rangeKey: 'clog_delta_sum',
  },
] as const

const FACILITY_AGGREGATE_RANGE_FILTERS = [
  {
    column: 'RISK',
    fallbackMax: 100,
    fallbackMin: 0,
    label: 'Risk',
    rangeKey: 'risk',
    step: '0.1',
  },
  {
    column: 'COND_RISK',
    fallbackMax: 100,
    fallbackMin: 0,
    label: 'Condition',
    rangeKey: 'condition_risk',
    step: '0.1',
  },
  {
    column: 'FLOOD_RISK',
    fallbackMax: 100,
    fallbackMin: 0,
    label: 'Flood',
    rangeKey: 'flood_risk',
    step: '0.1',
  },
  {
    column: 'CLOG_RISK',
    fallbackMax: 100,
    fallbackMin: 0,
    label: 'Clog',
    rangeKey: 'clog_risk',
    step: '0.1',
  },
] as const

const SOURCE_META: Record<SourceKey, { label: string; shortLabel: string; color: string; soft: string }> = {
  both: {
    label: 'Multiple Assets',
    shortLabel: 'Both',
    color: '#155e75',
    soft: '#e3f6fb',
  },
  pipes: {
    label: 'Pipes',
    shortLabel: 'Pipes',
    color: '#4e79a7',
    soft: '#e8f1fb',
  },
  structures: {
    label: 'Structures',
    shortLabel: 'Structures',
    color: '#7b5ea7',
    soft: '#f0ebf8',
  },
}

const METRIC_META: Record<MetricKey, { label: string; column: string; color: string }> = {
  risk: { label: 'Risk', column: 'RISK', color: '#155e75' },
  condition: { label: 'Condition Risk', column: 'COND_RISK', color: '#4e79a7' },
  flood: { label: 'Flood Risk', column: 'FLOOD_RISK', color: '#3f7f4a' },
  clog: { label: 'Clog Risk', column: 'CLOG_RISK', color: '#c96f16' },
}

const HISTORY_SERIES = [
  { key: 'RISK', label: 'Risk', color: '#155e75' },
  { key: 'COND_RISK', label: 'Condition Risk', color: '#4e79a7' },
  { key: 'FLOOD_RISK', label: 'Flood Risk', color: '#3f7f4a' },
  { key: 'CLOG_RISK', label: 'Clog Risk', color: '#c96f16' },
]

const TABLE_HEADER_LABELS: Record<string, string> = {
  FacilityID: 'Facility ID',
  ITPIPE_ASSETID: 'ITPipe Asset ID',
  INSPECTIONID: 'Inspection ID',
  INSPECTION_INDEX: 'Inspection Index',
  Inspection_Date: 'Inspection Date',
  INVESTIGATEDBY: 'Investigated By',
  investigator: 'Investigator',
  MATERIAL: 'Material',
  Pipe_Size: 'Pipe Size',
  RISK: 'Risk',
  RISK_DELTA: 'Risk Delta',
  COND_RISK: 'Condition Risk',
  COND_RISK_DELTA: 'Condition Risk Delta',
  CLOG_RISK: 'Clog Risk',
  CLOG_RISK_DELTA: 'Clog Risk Delta',
  FLOOD_RISK: 'Flood Risk',
  FLOOD_RISK_DELTA: 'Flood Risk Delta',
}

const TABLE_COLUMN_WIDTHS: Record<string, number> = {
  FacilityID: 66,
  ITPIPE_ASSETID: 92,
  INSPECTIONID: 82,
  INSPECTION_INDEX: 74,
  Inspection_Date: 126,
  INVESTIGATEDBY: 104,
  investigator: 104,
  MATERIAL: 84,
  Pipe_Size: 56,
  RISK: 52,
  RISK_DELTA: 62,
  COND_RISK: 70,
  COND_RISK_DELTA: 82,
  CLOG_RISK: 64,
  CLOG_RISK_DELTA: 76,
  FLOOD_RISK: 68,
  FLOOD_RISK_DELTA: 82,
}

const ASSET_SHEETS: AssetSheet[] = [
  {
    id: 'risk-facility-aggregate-pipes',
    title: 'Risk Facility Aggregate - Pipes',
    workbookTitle: 'Risk Facility Aggregate (Pipes)',
    category: 'Facility Aggregates',
    description: 'Risk scores summarized by facility for pipe assets.',
    kind: 'aggregate',
    source: 'pipes',
    metric: 'risk',
    icon: BarChart3,
  },
  {
    id: 'condition-facility-aggregate-both',
    title: 'Condition Risk Facility Aggregate - Both',
    workbookTitle: 'Condition Risk Facility Aggregate (Both)',
    category: 'Facility Aggregates',
    description: 'Condition risk summarized by facility across pipes and structures.',
    kind: 'aggregate',
    source: 'both',
    metric: 'condition',
    icon: BarChart3,
  },
  {
    id: 'condition-facility-aggregate-pipes',
    title: 'Condition Risk Facility Aggregate - Pipes',
    workbookTitle: 'Condition Risk Facility Aggregate (Pipes)',
    category: 'Facility Aggregates',
    description: 'Condition risk summarized by facility for pipe assets.',
    kind: 'aggregate',
    source: 'pipes',
    metric: 'condition',
    icon: BarChart3,
  },
  {
    id: 'condition-facility-aggregate-structures',
    title: 'Condition Risk Facility Aggregate - Structures',
    workbookTitle: 'Condition Risk Facility Aggregate (Structures)',
    category: 'Facility Aggregates',
    description: 'Condition risk summarized by facility for structure assets.',
    kind: 'aggregate',
    source: 'structures',
    metric: 'condition',
    icon: BarChart3,
  },
  {
    id: 'flood-facility-aggregate-pipes',
    title: 'Flood Risk Facility Aggregate - Pipes',
    workbookTitle: 'Flood Risk Facility Aggregate (Pipes)',
    category: 'Facility Aggregates',
    description: 'Flood risk summarized by facility for pipe assets.',
    kind: 'aggregate',
    source: 'pipes',
    metric: 'flood',
    icon: BarChart3,
  },
  {
    id: 'clog-facility-aggregate-pipes',
    title: 'Clog Risk Facility Aggregate - Pipes',
    workbookTitle: 'Clog Risk Facility Aggregate (Pipes)',
    category: 'Facility Aggregates',
    description: 'Clog risk summarized by facility for pipe assets.',
    kind: 'aggregate',
    source: 'pipes',
    metric: 'clog',
    icon: BarChart3,
  },
  {
    id: 'history-graph-both',
    title: 'History Graph - Both',
    workbookTitle: 'History Graph (Both)',
    category: 'History',
    description: 'Monthly average risk trend across all tracked assets.',
    kind: 'history',
    source: 'both',
    icon: BarChart3,
  },
  {
    id: 'history-table-both',
    title: 'History Table - Both',
    workbookTitle: 'History Table (Both)',
    category: 'History',
    description: 'Paged, sortable inspection history across pipes and structures.',
    kind: 'table',
    source: 'both',
    icon: Table2,
  },
  {
    id: 'history-table-pipes',
    title: 'History Table - Pipes',
    workbookTitle: 'History Table (Pipes)',
    category: 'History',
    description: 'Paged, sortable pipe inspection history with pipe-specific fields.',
    kind: 'table',
    source: 'pipes',
    icon: Table2,
  },
]

function createInitialFilters(): FilterState {
  return {
    search: '',
    facilityId: '',
    assetId: '',
    inspectionCount: '',
    inspectionDate: '',
    material: [],
    streetWater: 'all',
    mostRecent: 'all',
    numeric: Object.fromEntries(NUMERIC_FILTER_KEYS.map((key) => [key, { min: '', max: '' }])),
    flags: {},
  }
}

function createEmptyTableColumnFilters(): TableColumnFilters {
  return {
    numeric: {},
    dates: {},
    text: {},
    multi: {},
  }
}

function hasActiveTableColumnFilters(filters: TableColumnFilters) {
  return (
    Object.values(filters.numeric).some((range) => range.min !== '' || range.max !== '') ||
    Object.values(filters.dates).some((range) => range.from !== '' || range.to !== '') ||
    Object.values(filters.text).some((value) => value.trim() !== '') ||
    Object.values(filters.multi).some((values) => values.length > 0)
  )
}

function hasActiveAssetFilters(filters: FilterState) {
  return (
    filters.search.trim() !== '' ||
    filters.facilityId.trim() !== '' ||
    filters.assetId.trim() !== '' ||
    filters.inspectionCount.trim() !== '' ||
    filters.inspectionDate.trim() !== '' ||
    filters.material.length > 0 ||
    filters.streetWater !== 'all' ||
    filters.mostRecent !== 'all' ||
    Object.values(filters.numeric).some((range) => range.min !== '' || range.max !== '') ||
    Object.values(filters.flags).some((value) => value !== 'all')
  )
}

function filterPanelModeForSheet(sheet: AssetSheet): AssetFilterPanelMode {
  if (sheet.id === 'history-graph-both') {
    return 'history-graph-both'
  }
  if (sheet.id === 'history-table-both') {
    return 'history-table-both'
  }
  if (sheet.id === 'history-table-pipes') {
    return 'history-table-pipes'
  }
  return 'full'
}

function filtersForSheet(sheet: AssetSheet, filters: FilterState): FilterState {
  const mode = filterPanelModeForSheet(sheet)
  if (mode === 'full') {
    return { ...filters, inspectionCount: '', inspectionDate: '' }
  }

  if (mode === 'history-graph-both') {
    const initialFilters = createInitialFilters()
    return {
      ...initialFilters,
      search: filters.search,
      facilityId: filters.facilityId,
      assetId: filters.assetId,
      inspectionCount: '',
      material: filters.material,
      streetWater: filters.streetWater,
      mostRecent: filters.mostRecent,
      numeric: {
        ...initialFilters.numeric,
        condition_delta_sum: filters.numeric.condition_delta_sum,
        risk_delta_sum: filters.numeric.risk_delta_sum,
        flood_delta_sum: filters.numeric.flood_delta_sum,
        clog_delta_sum: filters.numeric.clog_delta_sum,
        inspection_count:
          filters.numeric.inspection_count.min || filters.numeric.inspection_count.max
            ? filters.numeric.inspection_count
            : { min: '3', max: '4' },
      },
    }
  }

  return {
    ...createInitialFilters(),
    search: filters.search,
    streetWater: filters.streetWater,
    mostRecent: filters.mostRecent,
    numeric: {
      ...createInitialFilters().numeric,
      inspection_count: filters.numeric.inspection_count,
      condition_delta_sum: filters.numeric.condition_delta_sum,
      risk_delta_sum: filters.numeric.risk_delta_sum,
      flood_delta_sum: filters.numeric.flood_delta_sum,
      clog_delta_sum: filters.numeric.clog_delta_sum,
    },
    flags: mode === 'history-table-pipes' ? filters.flags : {},
  }
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '-'
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)
}

function formatCellValue(value: CellValue) {
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? formatNumber(value) : formatNumber(value, 2)
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10)
  }
  return value
}

function groupValue(row: AssetRow, column: string) {
  const value = row[column]
  return value === null || value === undefined ? '' : String(value)
}

function sameValue(left: AssetRow | undefined, right: AssetRow | undefined, column: string) {
  if (!left || !right) {
    return false
  }
  return groupValue(left, column) === groupValue(right, column)
}

function isGroupedRowHeader(column: string) {
  return column === 'FacilityID' || column === 'ITPIPE_ASSETID'
}

function tableHeaderLabel(column: string) {
  return TABLE_HEADER_LABELS[column] ?? column.replaceAll('_', ' ')
}

function tableColumnWidth(column: string) {
  return TABLE_COLUMN_WIDTHS[column] ?? 116
}

function isNumericTableColumn(column: string) {
  return column in TABLE_COLUMN_WIDTHS && column !== 'ITPIPE_ASSETID' && column !== 'Inspection_Date' && !isChecklistTableColumn(column)
}

function isDateTableColumn(column: string) {
  return column === 'Inspection_Date'
}

function isTextTableColumn(column: string) {
  return column === 'ITPIPE_ASSETID'
}

function isChecklistTableColumn(column: string) {
  return column === 'INVESTIGATEDBY' || column === 'investigator' || column === 'MATERIAL'
}

function shouldSkipMergedCell(rows: AssetRow[], rowIndex: number, column: string) {
  if (rowIndex === 0) {
    return false
  }
  const row = rows[rowIndex]
  const previous = rows[rowIndex - 1]
  if (column === 'FacilityID') {
    return sameValue(row, previous, 'FacilityID')
  }
  if (column === 'ITPIPE_ASSETID') {
    return sameValue(row, previous, 'FacilityID') && sameValue(row, previous, 'ITPIPE_ASSETID')
  }
  return false
}

function mergedCellRowSpan(rows: AssetRow[], rowIndex: number, column: string) {
  if (!isGroupedRowHeader(column) || shouldSkipMergedCell(rows, rowIndex, column)) {
    return 0
  }

  let span = 1
  for (let nextIndex = rowIndex + 1; nextIndex < rows.length; nextIndex += 1) {
    if (column === 'FacilityID' && sameValue(rows[rowIndex], rows[nextIndex], 'FacilityID')) {
      span += 1
      continue
    }
    if (
      column === 'ITPIPE_ASSETID' &&
      sameValue(rows[rowIndex], rows[nextIndex], 'FacilityID') &&
      sameValue(rows[rowIndex], rows[nextIndex], 'ITPIPE_ASSETID')
    ) {
      span += 1
      continue
    }
    break
  }

  return span
}

function tableRowClassName(rows: AssetRow[], rowIndex: number, selected: boolean) {
  const classes = selected ? ['selected-row'] : []
  if (rowIndex > 0 && !sameValue(rows[rowIndex], rows[rowIndex - 1], 'FacilityID')) {
    classes.push('facility-group-start')
  } else if (rowIndex > 0 && !sameValue(rows[rowIndex], rows[rowIndex - 1], 'ITPIPE_ASSETID')) {
    classes.push('asset-group-start')
  }
  return classes.join(' ')
}

function toNumber(value: CellValue) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function fileNameSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'
}

function downloadDataUrl(dataUrl: string, fileName: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
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
  <sheets><sheet name="${escapeXml(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets>
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

function xlsxCell(value: CellValue, rowIndex: number, columnIndex: number) {
  const cellRef = `${columnLetter(columnIndex)}${rowIndex}`
  if (value === null || value === undefined || value === '') {
    return `<c r="${cellRef}"/>`
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${cellRef}"><v>${value}</v></c>`
  }
  return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(String(formatCellValue(value)))}</t></is></c>`
}

function createRowsXlsx(columns: string[], rows: AssetRow[], sheetName: string) {
  const headerCells = columns
    .map((column, columnIndex) => `<c r="${columnLetter(columnIndex)}1" t="inlineStr"><is><t>${escapeXml(column)}</t></is></c>`)
    .join('')
  const bodyRows = rows
    .map((row, rowIndex) => {
      const sheetRowIndex = rowIndex + 2
      const cells = columns.map((column, columnIndex) => xlsxCell(row[column], sheetRowIndex, columnIndex)).join('')
      return `<row r="${sheetRowIndex}">${cells}</row>`
    })
    .join('')
  const lastCell = `${columnLetter(Math.max(columns.length - 1, 0))}${Math.max(1, rows.length + 1)}`
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetData>
    <row r="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
</worksheet>`
  return worksheetPackage(sheetName, worksheet)
}

function downloadRowsXlsx(columns: string[], rows: AssetRow[], sheetName: string) {
  const workbook = createRowsXlsx(columns, rows, sheetName)
  const blob = new Blob([workbook], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileNameSlug(sheetName)}-${new Date().toISOString().slice(0, 10)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function createAggregateChartOption(
  sheet: AssetSheet,
  rows: AggregateRow[],
  measure: ChartMeasure,
  showLabels: boolean,
): EChartsOption {
  const metric = sheet.metric ? METRIC_META[sheet.metric] : METRIC_META.risk
  const measureLabels: Record<ChartMeasure, string> = {
    avg_value: 'Average',
    median_value: 'Median',
    max_value: 'Max',
    sum_value: 'Total',
  }
  const label = `${measureLabels[measure]} ${metric.label}`
  const topRows = rows
    .slice()
    .sort((left, right) => {
      const leftValue = left[measure]
      const rightValue = right[measure]
      if (leftValue === null && rightValue === null) {
        return Number(left.facility_id) - Number(right.facility_id)
      }
      if (leftValue === null) {
        return 1
      }
      if (rightValue === null) {
        return -1
      }
      if (rightValue !== leftValue) {
        return rightValue - leftValue
      }
      return Number(left.facility_id) - Number(right.facility_id)
    })
    .slice(0, 80)
  return {
    color: [metric.color],
    grid: { top: 28, right: 22, bottom: topRows.length > 18 ? 92 : 54, left: 56 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const item = Array.isArray(params) ? params[0] : params
        const row = topRows[item.dataIndex]
        return [
          `<strong>Facility ${row.facility_id}</strong>`,
          `${label}: ${formatNumber(Number(item.value), 2)}`,
          `Rows: ${formatNumber(row.row_count)}`,
          `Max: ${formatNumber(row.max_value, 2)}`,
          `Median: ${formatNumber(row.median_value, 2)}`,
        ].join('<br/>')
      },
    },
    xAxis: {
      type: 'category',
      data: topRows.map((row) => row.facility_id),
      axisTick: { alignWithLabel: true },
      axisLabel: { color: '#5b6879', rotate: topRows.length > 18 ? 55 : 0, interval: 0 },
    },
    yAxis: {
      type: 'value',
      name: label,
      nameTextStyle: { color: '#5b6879', fontWeight: 700 },
      axisLabel: { color: '#5b6879' },
      splitLine: { lineStyle: { color: '#d8e2ee' } },
    },
    dataZoom:
      topRows.length > 24
        ? [
            { type: 'inside', xAxisIndex: 0 },
            { type: 'slider', xAxisIndex: 0, height: 22, bottom: 16 },
          ]
        : [],
    series: [
      {
        type: 'bar',
        name: label,
        data: topRows.map((row) => row[measure]),
        barMaxWidth: 42,
        itemStyle: { borderRadius: [5, 5, 0, 0] },
        label: {
          show: showLabels,
          position: 'top',
          color: '#172033',
          fontWeight: 700,
          formatter: ({ value }) => formatNumber(Number(value), 1),
        },
        labelLayout: { hideOverlap: true },
      },
    ],
  }
}

function createHistoryChartOption(rows: AssetRow[], showLabels: boolean): EChartsOption {
  const expandedRows: Array<AssetRow | null> = []
  let previousAssetKey = ''
  for (const row of rows) {
    const assetKey = `${row.FacilityID ?? ''}|${row.ITPIPE_ASSETID ?? ''}`
    if (previousAssetKey && assetKey !== previousAssetKey) {
      expandedRows.push(null)
    }
    expandedRows.push(row)
    previousAssetKey = assetKey
  }

  const categories = expandedRows.map((row, index) => {
    if (!row) return `gap-${index}`
    const date = String(formatCellValue(row.Inspection_Date))
    return `${row.FacilityID ?? ''} / ${row.ITPIPE_ASSETID ?? ''} / ${date}`
  })
  const assetSplitterIndexes = new Set(expandedRows.flatMap((row, index) => (row === null ? [index] : [])))
  const assetLabels = new Map<number, string>()
  let assetStartIndex: number | null = null
  let assetEndIndex: number | null = null
  for (let index = 0; index <= expandedRows.length; index += 1) {
    const row = expandedRows[index]
    if (row) {
      assetStartIndex ??= index
      assetEndIndex = index
      continue
    }

    if (assetStartIndex !== null && assetEndIndex !== null) {
      const centerIndex = Math.round((assetStartIndex + assetEndIndex) / 2)
      const labelRow = expandedRows[assetStartIndex]
      assetLabels.set(
        centerIndex,
        `${formatCellValue(labelRow?.FacilityID ?? null)}\n${formatCellValue(labelRow?.ITPIPE_ASSETID ?? null)}`,
      )
    }
    assetStartIndex = null
    assetEndIndex = null
  }
  const xAxisIndices = HISTORY_SERIES.map((_, index) => index)
  const grid = HISTORY_SERIES.map((_, index) => ({
    top: index === 0 ? 34 : `${25 + (index - 1) * 20}%`,
    height: '14.5%',
    right: 28,
    left: 64,
  }))

  return {
    color: HISTORY_SERIES.map((series) => series.color),
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: '#334155', fontWeight: 700 },
    },
    grid,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (params) => {
        const items = Array.isArray(params) ? params : [params]
        const dataIndex = items[0]?.dataIndex
        const row = typeof dataIndex === 'number' ? expandedRows[dataIndex] : null
        if (!row) return ''
        const values = HISTORY_SERIES.map((series) => {
          const value = toNumber(row[series.key])
          return `${series.label}: ${value === null ? '-' : formatNumber(value, 2)}`
        })
        return [
          `<strong>Facility ${formatCellValue(row.FacilityID)} / ${formatCellValue(row.ITPIPE_ASSETID)}</strong>`,
          `Inspection Date: ${formatCellValue(row.Inspection_Date)}`,
          `Inspection ID: ${formatCellValue(row.INSPECTIONID)}`,
          ...values,
        ].join('<br/>')
      },
    },
    xAxis: HISTORY_SERIES.map((_, index) => ({
      type: 'category',
      gridIndex: index,
      boundaryGap: false,
      data: categories,
      axisTick: { show: false },
      axisLabel: {
        color: '#5b6879',
        fontSize: 11,
        fontWeight: 720,
        hideOverlap: index === HISTORY_SERIES.length - 1,
        interval: 0,
        lineHeight: 15,
        margin: 12,
        show: index === HISTORY_SERIES.length - 1,
        formatter: (_value: string, labelIndex: number) => {
          return assetLabels.get(labelIndex) ?? ''
        },
      },
      splitLine: {
        show: assetSplitterIndexes.size > 0,
        interval: (index: number) => assetSplitterIndexes.has(index),
        lineStyle: { color: 'rgba(71, 85, 105, 0.72)', width: 1.5, type: 'solid' },
      },
    })),
    yAxis: HISTORY_SERIES.map((series, index) => ({
      type: 'value',
      gridIndex: index,
      name: series.label,
      nameTextStyle: { color: series.color, fontWeight: 760 },
      axisLabel: { color: '#5b6879' },
      splitLine: { lineStyle: { color: '#d8e2ee' } },
      min: 0,
    })),
    dataZoom:
      categories.length > 40
        ? [
            { type: 'inside', xAxisIndex: xAxisIndices },
            { type: 'slider', xAxisIndex: xAxisIndices, height: 20, bottom: 2 },
          ]
        : [],
    series: HISTORY_SERIES.map((series, index) => ({
      type: 'line',
      name: series.label,
      xAxisIndex: index,
      yAxisIndex: index,
      smooth: false,
      connectNulls: false,
      symbolSize: 6,
      lineStyle: { width: 2.5 },
      data: expandedRows.map((row) => (row ? toNumber(row[series.key]) : null)),
      label: {
        show: showLabels,
        position: 'top',
        color: series.color,
        fontSize: 11,
        fontWeight: 760,
        formatter: ({ value }) => (value === null || value === undefined ? '' : formatNumber(Number(value), 1)),
      },
      labelLayout: { hideOverlap: true },
      areaStyle: { opacity: 0.04 },
    })),
  }
}

export default function CriticalAssetTrackingDashboard() {
  const [selectedSheetId, setSelectedSheetId] = useState('risk-facility-aggregate-pipes')
  const [filterOptions, setFilterOptions] = useState<FilterOptionsResponse | null>(null)
  const [aggregates, setAggregates] = useState<AggregatesResponse | null>(null)
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [table, setTable] = useState<TableResponse | null>(null)
  const [filters, setFilters] = useState<FilterState>(createInitialFilters)
  const [tableColumnFilters, setTableColumnFilters] = useState<TableColumnFilters>(createEmptyTableColumnFilters)
  const [tablePage, setTablePage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [sort, setSort] = useState<TableSortState>({ column: 'FacilityID', direction: 'asc' })
  const [measure, setMeasure] = useState<ChartMeasure>('avg_value')
  const [showAggregateLabels, setShowAggregateLabels] = useState(false)
  const [showHistoryLabels, setShowHistoryLabels] = useState(true)
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chartRef = useRef<EChartHandle | null>(null)

  const selectedSheet = useMemo(
    () => ASSET_SHEETS.find((sheet) => sheet.id === selectedSheetId) ?? ASSET_SHEETS[0],
    [selectedSheetId],
  )
  const filtersActive = useMemo(
    () => hasActiveAssetFilters(filters) || hasActiveTableColumnFilters(tableColumnFilters),
    [filters, tableColumnFilters],
  )
  const effectiveFilters = useMemo(() => filtersForSheet(selectedSheet, filters), [selectedSheet, filters])
  const filterPanelMode = filterPanelModeForSheet(selectedSheet)
  const activeSource = selectedSheet.source ?? 'both'
  const activePipeFlags = activeSource === 'pipes' ? filterOptions?.pipe_flags ?? [] : []
  const filterButton = (
    <AssetFilterButton
      activeFlags={activePipeFlags}
      filters={filters}
      mode={filterPanelMode}
      onChange={updateFilters}
      onClear={clearFilters}
      options={filterOptions}
      source={activeSource}
    />
  )

  useEffect(() => {
    document.documentElement.classList.add('critical-asset-dashboard-active')
    return () => {
      document.documentElement.classList.remove('critical-asset-dashboard-active')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetchFilterOptions()
      .then((nextOptions) => {
        if (cancelled) return
        setFilterOptions(nextOptions)
      })
      .catch((nextError: unknown) => {
        if (cancelled) return
        setError(nextError instanceof Error ? nextError.message : String(nextError))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setSelectedRowIndex(null)
    setError(null)

    setLoadingContent(true)
    if (selectedSheet.kind === 'aggregate' && selectedSheet.source && selectedSheet.metric) {
      fetchAggregates(selectedSheet.source, selectedSheet.metric, effectiveFilters, 1000)
        .then((nextAggregates) => {
          if (!cancelled) setAggregates(nextAggregates)
        })
        .catch((nextError: unknown) => {
          if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError))
        })
        .finally(() => {
          if (!cancelled) setLoadingContent(false)
        })
    } else if (selectedSheet.kind === 'history' && selectedSheet.source) {
      fetchHistory(
        selectedSheet.source,
        effectiveFilters,
        10000,
        selectedSheet.id === 'history-graph-both' ? 'history_graph_both' : undefined,
      )
        .then((nextHistory) => {
          if (!cancelled) setHistory(nextHistory)
        })
        .catch((nextError: unknown) => {
          if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError))
        })
        .finally(() => {
          if (!cancelled) setLoadingContent(false)
        })
    } else if (selectedSheet.kind === 'table' && selectedSheet.source) {
      fetchTable(
        {
          source: selectedSheet.source,
          limit: pageSize,
          offset: tablePage * pageSize,
          sortBy: sort.column,
          sortDir: sort.direction,
        },
        effectiveFilters,
        tableColumnFilters,
      )
        .then((nextTable) => {
          if (!cancelled) setTable(nextTable)
        })
        .catch((nextError: unknown) => {
          if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError))
        })
        .finally(() => {
          if (!cancelled) setLoadingContent(false)
        })
    }

    return () => {
      cancelled = true
    }
  }, [selectedSheet, effectiveFilters, tableColumnFilters, pageSize, tablePage, sort])

  function selectSheet(sheetId: string) {
    setSelectedSheetId(sheetId)
    setTablePage(0)
    setSort({ column: 'FacilityID', direction: 'asc' })
    setTableColumnFilters(createEmptyTableColumnFilters())
  }

  function updateFilters(next: FilterState | ((current: FilterState) => FilterState)) {
    setTablePage(0)
    setFilters(next)
  }

  function clearFilters() {
    setTablePage(0)
    setFilters(createInitialFilters())
    setTableColumnFilters(createEmptyTableColumnFilters())
  }

  function updateTableColumnFilters(next: TableColumnFilters | ((current: TableColumnFilters) => TableColumnFilters)) {
    setTablePage(0)
    setTableColumnFilters(next)
  }

  function exportCurrentChart(type: 'png' | 'jpg') {
    const dataUrl = chartRef.current?.exportImage(type, CHART_EXPORT_PIXEL_RATIO)
    if (!dataUrl) {
      return
    }
    downloadDataUrl(dataUrl, `${fileNameSlug(selectedSheet.title)}.${type}`)
  }

  async function downloadCurrentTable() {
    if (!selectedSheet.source || !table) {
      return
    }
    setDownloading(true)
    try {
      const rows: AssetRow[] = []
      const limit = 1000
      for (let offset = 0; offset < table.total; offset += limit) {
        const page = await fetchTable(
          {
            source: selectedSheet.source,
            limit,
            offset,
            sortBy: sort.column,
            sortDir: sort.direction,
          },
          effectiveFilters,
          tableColumnFilters,
        )
        rows.push(...page.rows)
      }
      downloadRowsXlsx(table.columns, rows, selectedSheet.title)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="workbook-shell asset-dashboard detail-mode">
      <aside className="left-nav">
        <div className="brand-block">
          <div className="brand-mark">
            <Gauge size={23} />
          </div>
          <div>
            <strong>Critical Asset Tracking</strong>
            <span>Track critical assets using risk assessment results</span>
          </div>
        </div>

        {(['Facility Aggregates', 'History'] as const).map((category) => (
          <div className="nav-group" key={category}>
            <span>{category}</span>
            {ASSET_SHEETS.filter((sheet) => sheet.category === category).map((sheet) => {
              const Icon = sheet.icon
              return (
                <button
                  className={selectedSheet.id === sheet.id ? 'active' : ''}
                  key={sheet.id}
                  onClick={() => selectSheet(sheet.id)}
                  type="button"
                >
                  <Icon size={18} />
                  <span>{sheet.title}</span>
                </button>
              )
            })}
          </div>
        ))}
      </aside>

      <main className="sheet-canvas asset-canvas">
        {error ? <div className="error-banner">{error}</div> : null}

        {selectedSheet.kind === 'aggregate' ? (
          <AggregatePanel
            data={aggregates}
            loading={loadingContent}
            measure={measure}
            filterButton={filterButton}
            onExport={exportCurrentChart}
            onMeasureChange={setMeasure}
            onShowLabelsChange={setShowAggregateLabels}
            showLabels={showAggregateLabels}
            sheet={selectedSheet}
            chartRef={chartRef}
          />
        ) : null}

        {selectedSheet.kind === 'history' ? (
          <HistoryPanel
            chartRef={chartRef}
            data={history}
            filterButton={filterButton}
            loading={loadingContent}
            onExport={exportCurrentChart}
            onShowLabelsChange={setShowHistoryLabels}
            showLabels={showHistoryLabels}
            sheet={selectedSheet}
          />
        ) : null}

        {selectedSheet.kind === 'table' ? (
          <AssetTablePanel
            data={table}
            downloading={downloading}
            filterButton={filterButton}
            filterOptions={filterOptions}
            columnFilters={tableColumnFilters}
            loading={loadingContent}
            onDownload={downloadCurrentTable}
            onColumnFiltersChange={updateTableColumnFilters}
            onClearFilters={clearFilters}
            onPageChange={setTablePage}
            onPageSizeChange={(nextSize) => {
              setPageSize(nextSize)
              setTablePage(0)
            }}
            onRowSelect={setSelectedRowIndex}
            onSortChange={setSort}
            page={tablePage}
            pageSize={pageSize}
            selectedRowIndex={selectedRowIndex}
            sheet={selectedSheet}
            sort={sort}
            filtersActive={filtersActive}
          />
        ) : null}
      </main>
    </div>
  )
}

function AggregatePanel({
  chartRef,
  data,
  filterButton,
  loading,
  measure,
  onExport,
  onMeasureChange,
  onShowLabelsChange,
  sheet,
  showLabels,
}: {
  chartRef: MutableRefObject<EChartHandle | null>
  data: AggregatesResponse | null
  filterButton: ReactNode
  loading: boolean
  measure: ChartMeasure
  onExport: (type: 'png' | 'jpg') => void
  onMeasureChange: (measure: ChartMeasure) => void
  onShowLabelsChange: (showLabels: boolean) => void
  sheet: AssetSheet
  showLabels: boolean
}) {
  const rows = data?.rows ?? []
  const option = useMemo(() => createAggregateChartOption(sheet, rows, measure, showLabels), [sheet, rows, measure, showLabels])
  const totalRows = rows.reduce((sum, row) => sum + row.row_count, 0)
  const topMax = rows[0]?.max_value ?? null
  const rowsWithAverage = rows.filter((row) => row.avg_value !== null)
  const averageValue = rowsWithAverage.length
    ? rowsWithAverage.reduce((sum, row) => sum + (row.avg_value ?? 0), 0) / rowsWithAverage.length
    : null

  return (
    <section className="sheet-panel chart-panel asset-chart-panel">
      <div className="panel-header">
        <div className="panel-title-copy">
          <h2>{sheet.title}</h2>
          <p>{sheet.description}</p>
        </div>
        <div className="asset-chart-actions">
          <div className="chart-view-toggle">
            {[
              ['avg_value', 'Average'],
              ['median_value', 'Median'],
              ['max_value', 'Max'],
              ['sum_value', 'Total'],
            ].map(([key, label]) => (
              <button
                className={measure === key ? 'active' : ''}
                key={key}
                onClick={() => onMeasureChange(key as ChartMeasure)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <ChartLabelsSwitch checked={showLabels} onChange={onShowLabelsChange} />
          <ChartExportButton onExport={onExport} />
          {filterButton}
        </div>
      </div>

      <div className="asset-stat-strip">
        <span>{formatNumber(rows.length)} facilities</span>
        <span>{formatNumber(totalRows)} records</span>
        <span>{formatNumber(averageValue, 2)} avg score</span>
        <span>{formatNumber(topMax, 2)} top score</span>
      </div>

      <div className="asset-chart-body">
        {loading ? <div className="loading-bar">Loading chart...</div> : <EChart height="100%" option={option} ref={chartRef} />}
      </div>
    </section>
  )
}

function HistoryPanel({
  chartRef,
  data,
  filterButton,
  loading,
  onExport,
  onShowLabelsChange,
  sheet,
  showLabels,
}: {
  chartRef: MutableRefObject<EChartHandle | null>
  data: HistoryResponse | null
  filterButton: ReactNode
  loading: boolean
  onExport: (type: 'png' | 'jpg') => void
  onShowLabelsChange: (showLabels: boolean) => void
  sheet: AssetSheet
  showLabels: boolean
}) {
  const rows = data?.rows ?? []
  const option = useMemo(() => createHistoryChartOption(rows, showLabels), [rows, showLabels])
  return (
    <section className="sheet-panel chart-panel asset-chart-panel">
      <div className="panel-header">
        <div className="panel-title-copy">
          <h2>{sheet.title}</h2>
          <p>{sheet.description}</p>
        </div>
        <div className="asset-chart-actions">
          <ChartLabelsSwitch checked={showLabels} onChange={onShowLabelsChange} />
          <ChartExportButton onExport={onExport} />
          {filterButton}
        </div>
      </div>
      <div className="asset-chart-body">
        {loading ? <div className="loading-bar">Loading trend...</div> : <EChart height="100%" option={option} ref={chartRef} />}
      </div>
    </section>
  )
}

function AssetTablePanel({
  columnFilters,
  data,
  downloading,
  filterButton,
  filtersActive,
  filterOptions,
  loading,
  onClearFilters,
  onColumnFiltersChange,
  onDownload,
  onPageChange,
  onPageSizeChange,
  onRowSelect,
  onSortChange,
  page,
  pageSize,
  selectedRowIndex,
  sheet,
  sort,
}: {
  columnFilters: TableColumnFilters
  data: TableResponse | null
  downloading: boolean
  filterButton: ReactNode
  filtersActive: boolean
  filterOptions: FilterOptionsResponse | null
  loading: boolean
  onClearFilters: () => void
  onColumnFiltersChange: (next: TableColumnFilters | ((current: TableColumnFilters) => TableColumnFilters)) => void
  onDownload: () => void
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onRowSelect: (index: number | null) => void
  onSortChange: (sort: TableSortState) => void
  page: number
  pageSize: number
  selectedRowIndex: number | null
  sheet: AssetSheet
  sort: TableSortState
}) {
  const rows = data?.rows ?? []
  const columns = data?.columns ?? []
  const total = data?.total ?? 0
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1)
  const start = total === 0 ? 0 : page * pageSize + 1
  const end = Math.min(total, (page + 1) * pageSize)

  function toggleSort(column: string) {
    onSortChange({
      column,
      direction: sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc',
    })
    onPageChange(0)
  }

  return (
    <section className="sheet-panel table-panel asset-table-panel">
      <div className="panel-header">
        <div className="panel-title-copy">
          <h2>{sheet.title}</h2>
          <p>{sheet.description}</p>
        </div>
        <div className="asset-chart-actions">
          <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
            <SelectTrigger className="page-size-select" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TABLE_PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="table-clear-filters-button"
            disabled={!filtersActive}
            onClick={onClearFilters}
            size="sm"
            type="button"
            variant="outline"
          >
            <X size={14} />
            Clear filters
          </Button>
          <Button
            className="table-download-button"
            disabled={!data || downloading}
            onClick={onDownload}
            size="sm"
            type="button"
            variant="outline"
          >
            <Download size={14} />
            {downloading ? 'Exporting...' : 'Download XLSX'}
          </Button>
          {filterButton}
        </div>
      </div>

      <div className="asset-table-meta">
        <span>{formatNumber(total)} records</span>
        <span>
          Showing {formatNumber(start)}-{formatNumber(end)}
        </span>
      </div>

      <div className="table-wrap asset-table-wrap">
        {loading ? <div className="loading-bar">Loading table...</div> : null}
        <table className="detail-table asset-data-table">
          <colgroup>
            {columns.map((column) => (
              <col key={column} style={{ width: tableColumnWidth(column) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>
                  <button
                    className={`sort-button ${sort.column === column ? 'active' : ''}`}
                    onClick={() => toggleSort(column)}
                    title={`Sort by ${column}`}
                    type="button"
                  >
                    <span>{tableHeaderLabel(column)}</span>
                    {sort.column === column ? (
                      sort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />
                    ) : (
                      <ArrowDownUp size={14} />
                    )}
                  </button>
                </th>
              ))}
            </tr>
            <tr className="asset-column-filter-row">
              {columns.map((column) => (
                <th key={column}>
                  <TableColumnFilter
                    column={column}
                    filters={columnFilters}
                    onChange={onColumnFiltersChange}
                    options={filterOptions}
                    source={sheet.source ?? 'both'}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                className={tableRowClassName(rows, rowIndex, selectedRowIndex === rowIndex)}
                key={`${rowIndex}-${row.INSPECTIONID ?? row.ITPIPE_ASSETID ?? ''}`}
                onClick={() => onRowSelect(selectedRowIndex === rowIndex ? null : rowIndex)}
              >
                {columns.map((column) => {
                  const rowSpan = isGroupedRowHeader(column) ? mergedCellRowSpan(rows, rowIndex, column) : 1
                  if (isGroupedRowHeader(column) && rowSpan === 0) return null
                  const displayValue = formatCellValue(row[column])
                  return (
                    <td
                      className={isGroupedRowHeader(column) ? 'table-row-heading merged-cell' : ''}
                      key={column}
                      rowSpan={rowSpan > 1 ? rowSpan : undefined}
                      title={String(formatCellValue(row[column]))}
                    >
                      {displayValue}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pagination asset-pagination">
        <button disabled={page <= 0} onClick={() => onPageChange(0)} type="button">
          First
        </button>
        <button disabled={page <= 0} onClick={() => onPageChange(Math.max(0, page - 1))} type="button">
          Previous
        </button>
        <span>
          Page {formatNumber(page + 1)} of {formatNumber(maxPage + 1)}
        </span>
        <button disabled={page >= maxPage} onClick={() => onPageChange(Math.min(maxPage, page + 1))} type="button">
          Next
        </button>
        <button disabled={page >= maxPage} onClick={() => onPageChange(maxPage)} type="button">
          Last
        </button>
      </div>
    </section>
  )
}

function TableColumnFilter({
  column,
  filters,
  onChange,
  options,
  source,
}: {
  column: string
  filters: TableColumnFilters
  onChange: (next: TableColumnFilters | ((current: TableColumnFilters) => TableColumnFilters)) => void
  options: FilterOptionsResponse | null
  source: SourceKey
}) {
  if (isNumericTableColumn(column)) {
    return (
      <NumericColumnFilter
        column={column}
        filters={filters}
        onChange={onChange}
        range={options?.sources[source]?.numeric_ranges?.[column]}
      />
    )
  }

  if (isDateTableColumn(column)) {
    return <DateColumnRangeFilter column={column} filters={filters} onChange={onChange} />
  }

  if (isTextTableColumn(column)) {
    return (
      <Input
        className="asset-column-filter-input"
        placeholder="Search"
        value={filters.text[column] ?? ''}
        onChange={(event) =>
          onChange((current) => ({
            ...current,
            text: { ...current.text, [column]: event.target.value },
          }))
        }
      />
    )
  }

  if (isChecklistTableColumn(column)) {
    return (
      <ChecklistColumnFilter
        column={column}
        filters={filters}
        onChange={onChange}
        values={options?.sources[source]?.checklist_values?.[column] ?? []}
      />
    )
  }

  return <span className="asset-column-filter-empty">All</span>
}

function NumericColumnFilter({
  column,
  filters,
  onChange,
  range,
}: {
  column: string
  filters: TableColumnFilters
  onChange: (next: TableColumnFilters | ((current: TableColumnFilters) => TableColumnFilters)) => void
  range?: { min: number | null; max: number | null }
}) {
  const current = filters.numeric[column] ?? { min: '', max: '' }
  const minBound = Math.floor(range?.min ?? 0)
  const maxBound = Math.ceil(range?.max ?? 100)
  const canSlide = Number.isFinite(minBound) && Number.isFinite(maxBound) && maxBound > minBound
  const minValue = current.min === '' ? minBound : Number(current.min)
  const maxValue = current.max === '' ? maxBound : Number(current.max)
  const sliderMinValue = Number.isFinite(minValue) ? Math.min(Math.max(minValue, minBound), maxBound) : minBound
  const sliderMaxValue = Number.isFinite(maxValue) ? Math.max(Math.min(maxValue, maxBound), minBound) : maxBound
  const selectedMinValue = Math.min(sliderMinValue, sliderMaxValue)
  const selectedMaxValue = Math.max(sliderMinValue, sliderMaxValue)
  const minPercent = canSlide ? ((selectedMinValue - minBound) / (maxBound - minBound)) * 100 : 0
  const maxPercent = canSlide ? ((selectedMaxValue - minBound) / (maxBound - minBound)) * 100 : 100
  const label = current.min || current.max ? `${current.min || minBound} - ${current.max || maxBound}` : 'Any'
  const integerSlider = column === 'INSPECTION_INDEX' || column === 'Pipe_Size'
  const sliderStep = integerSlider ? '1' : '0.1'
  const formatSliderValue = integerSlider ? (value: number) => String(Math.round(value)) : sliderText

  function setRange(next: { min?: string; max?: string }) {
    onChange((state) => ({
      ...state,
      numeric: {
        ...state.numeric,
        [column]: {
          min: next.min ?? state.numeric[column]?.min ?? '',
          max: next.max ?? state.numeric[column]?.max ?? '',
        },
      },
    }))
  }

  function clearRange() {
    onChange((state) => {
      const nextNumeric = { ...state.numeric }
      delete nextNumeric[column]
      return { ...state, numeric: nextNumeric }
    })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={`asset-column-filter-button ${current.min || current.max ? 'active' : ''}`} type="button">
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="asset-table-filter-popover" align="start">
        <div className="asset-slider-filter">
          <strong>{tableHeaderLabel(column)}</strong>
          <div className="asset-slider-readout">
            <span>{formatNumber(minBound, 1)}</span>
            <span>{formatNumber(maxBound, 1)}</span>
          </div>
          <div
            className="asset-dual-range"
            style={{ '--min-pct': `${minPercent}%`, '--max-pct': `${maxPercent}%` } as CSSProperties}
          >
            <input
              aria-label={`${tableHeaderLabel(column)} minimum`}
              className="asset-dual-range-input"
              disabled={!canSlide}
              max={maxBound}
              min={minBound}
              onChange={(event) => setRange({ min: formatSliderValue(Math.min(Number(event.target.value), selectedMaxValue)) })}
              step={sliderStep}
              type="range"
              value={selectedMinValue}
            />
            <input
              aria-label={`${tableHeaderLabel(column)} maximum`}
              className="asset-dual-range-input"
              disabled={!canSlide}
              max={maxBound}
              min={minBound}
              onChange={(event) => setRange({ max: formatSliderValue(Math.max(Number(event.target.value), selectedMinValue)) })}
              step={sliderStep}
              type="range"
              value={selectedMaxValue}
            />
          </div>
          <div className="asset-slider-inputs">
            <Input
              inputMode="decimal"
              placeholder="Min"
              value={current.min}
              onChange={(event) => setRange({ min: event.target.value })}
            />
            <Input
              inputMode="decimal"
              placeholder="Max"
              value={current.max}
              onChange={(event) => setRange({ max: event.target.value })}
            />
          </div>
          <Button onClick={clearRange} size="sm" type="button" variant="outline">
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function DateColumnRangeFilter({
  column,
  filters,
  onChange,
}: {
  column: string
  filters: TableColumnFilters
  onChange: (next: TableColumnFilters | ((current: TableColumnFilters) => TableColumnFilters)) => void
}) {
  const current = filters.dates[column] ?? { from: '', to: '' }
  const label = current.from || current.to ? `${current.from || 'Start'} - ${current.to || 'End'}` : 'Any date'

  function setRange(next: { from?: string; to?: string }) {
    onChange((state) => ({
      ...state,
      dates: {
        ...state.dates,
        [column]: {
          from: next.from ?? state.dates[column]?.from ?? '',
          to: next.to ?? state.dates[column]?.to ?? '',
        },
      },
    }))
  }

  function clearRange() {
    onChange((state) => {
      const nextDates = { ...state.dates }
      delete nextDates[column]
      return { ...state, dates: nextDates }
    })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={`asset-column-filter-button ${current.from || current.to ? 'active' : ''}`} type="button">
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="asset-table-filter-popover" align="start">
        <div className="asset-date-filter">
          <strong>{tableHeaderLabel(column)}</strong>
          <label>
            From
            <Input type="date" value={current.from} onChange={(event) => setRange({ from: event.target.value })} />
          </label>
          <label>
            To
            <Input type="date" value={current.to} onChange={(event) => setRange({ to: event.target.value })} />
          </label>
          <Button onClick={clearRange} size="sm" type="button" variant="outline">
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ChecklistColumnFilter({
  column,
  filters,
  onChange,
  values,
}: {
  column: string
  filters: TableColumnFilters
  onChange: (next: TableColumnFilters | ((current: TableColumnFilters) => TableColumnFilters)) => void
  values: CellValue[]
}) {
  const selected = filters.multi[column] ?? []
  const label = selected.length ? `${selected.length} selected` : 'All'

  function toggle(value: string, checked: boolean) {
    onChange((state) => {
      const currentValues = state.multi[column] ?? []
      const nextValues = checked
        ? Array.from(new Set([...currentValues, value]))
        : currentValues.filter((item) => item !== value)
      const nextMulti = { ...state.multi }
      if (nextValues.length) {
        nextMulti[column] = nextValues
      } else {
        delete nextMulti[column]
      }
      return { ...state, multi: nextMulti }
    })
  }

  function clearSelected() {
    onChange((state) => {
      const nextMulti = { ...state.multi }
      delete nextMulti[column]
      return { ...state, multi: nextMulti }
    })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={`asset-column-filter-button ${selected.length ? 'active' : ''}`} type="button">
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="asset-table-filter-popover" align="start">
        <div className="asset-checklist-filter">
          <strong>{tableHeaderLabel(column)}</strong>
          <div>
            {values.map((value) => {
              const text = String(value)
              return (
                <label key={text}>
                  <Checkbox checked={selected.includes(text)} onCheckedChange={(checked) => toggle(text, checked === true)} />
                  <span>{text || 'Blank'}</span>
                </label>
              )
            })}
          </div>
          <Button onClick={clearSelected} size="sm" type="button" variant="outline">
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ChartLabelsSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      aria-pressed={checked}
      className={`chart-label-switch ${checked ? 'active' : ''}`}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span>Labels</span>
      <i aria-hidden="true" />
    </button>
  )
}

function ChartExportButton({ onExport }: { onExport: (type: 'png' | 'jpg') => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="chart-export-button" size="sm" type="button" variant="outline">
          <Download size={14} />
          Export
        </Button>
      </PopoverTrigger>
      <PopoverContent className="chart-export-popover" align="end">
        <Button onClick={() => onExport('png')} size="sm" type="button" variant="ghost">
          PNG
        </Button>
        <Button onClick={() => onExport('jpg')} size="sm" type="button" variant="ghost">
          JPG
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function AssetFilterButton({
  activeFlags,
  filters,
  mode,
  onChange,
  onClear,
  options,
  source,
}: {
  activeFlags: string[]
  filters: FilterState
  mode: AssetFilterPanelMode
  onChange: FilterUpdater
  onClear: () => void
  options: FilterOptionsResponse | null
  source: SourceKey
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="floating-filter-button" size="sm" type="button" variant="outline">
          <Filter size={14} />
          Filters
        </Button>
      </PopoverTrigger>
      <PopoverContent className="filter-popover-content asset-filter-popover" align="end">
        <AssetFiltersPanel
          activeFlags={activeFlags}
          filters={filters}
          mode={mode}
          onChange={onChange}
          onClear={onClear}
          options={options}
          source={source}
        />
      </PopoverContent>
    </Popover>
  )
}

function AssetFiltersPanel({
  activeFlags,
  filters,
  mode,
  onChange,
  onClear,
  options,
  source,
}: {
  activeFlags: string[]
  filters: FilterState
  mode: AssetFilterPanelMode
  onChange: FilterUpdater
  onClear: () => void
  options: FilterOptionsResponse | null
  source: SourceKey
}) {
  const sourceOptions = options?.sources[source]
  const materials = (sourceOptions?.materials ?? []).filter((value) => value !== null && value !== '')
  const compactHistoryTableFilters = mode === 'history-table-both' || mode === 'history-table-pipes'
  const historyGraphBothFilters = mode === 'history-graph-both'
  const showSpatialIntersections = (mode === 'full' || mode === 'history-table-pipes') && activeFlags.length > 0

  return (
    <div className="filter-card asset-filter-card">
      <div className="filter-title">
        <div>
          <Filter size={18} />
          <strong>Filters</strong>
        </div>
        <span>{SOURCE_META[source].shortLabel}</span>
      </div>

      <div className="filter-section">
        <label>Search</label>
        <div className="input-with-icon">
          <Search size={16} />
          <Input
            placeholder="Facility, asset, inspection, address"
            value={filters.search}
            onChange={(event) => onChange((current) => ({ ...current, search: event.target.value }))}
          />
        </div>
      </div>

      {compactHistoryTableFilters ? null : (
        <div className="asset-filter-grid">
          <div className="filter-section">
            <label>Facility ID</label>
            <Input
              value={filters.facilityId}
              onChange={(event) => onChange((current) => ({ ...current, facilityId: event.target.value }))}
            />
          </div>
          <div className="filter-section">
            <label>Asset ID</label>
            <Input
              value={filters.assetId}
              onChange={(event) => onChange((current) => ({ ...current, assetId: event.target.value }))}
            />
          </div>
        </div>
      )}

      {compactHistoryTableFilters ? (
        <SliderRangeFilter
          bounds={sourceOptions?.numeric_ranges?.INSPECTION_COUNT}
          defaultMax={sourceOptions?.numeric_ranges?.INSPECTION_COUNT?.max ?? 10}
          defaultMin={sourceOptions?.numeric_ranges?.INSPECTION_COUNT?.min ?? 1}
          formatValue={(value) => String(Math.round(value))}
          label="Inspection Count"
          onChange={onChange}
          range={filters.numeric.inspection_count}
          rangeKey="inspection_count"
          step="1"
        />
      ) : (
        <>
          {historyGraphBothFilters ? (
            <SliderRangeFilter
              bounds={sourceOptions?.numeric_ranges?.INSPECTION_COUNT}
              defaultMax={4}
              defaultMin={3}
              formatValue={(value) => String(Math.round(value))}
              label="Inspection Count"
              onChange={onChange}
              range={filters.numeric.inspection_count}
              rangeKey="inspection_count"
              step="1"
            />
          ) : (
            <SliderRangeFilter
              bounds={sourceOptions?.numeric_ranges?.INSPECTION_COUNT}
              defaultMax={sourceOptions?.numeric_ranges?.INSPECTION_COUNT?.max ?? 10}
              defaultMin={sourceOptions?.numeric_ranges?.INSPECTION_COUNT?.min ?? 1}
              formatValue={(value) => String(Math.round(value))}
              label="Inspection Count"
              onChange={onChange}
              range={filters.numeric.inspection_count}
              rangeKey="inspection_count"
              step="1"
            />
          )}

          <MaterialMultiSelectFilter materials={materials} onChange={onChange} selected={filters.material} />
        </>
      )}

      <BooleanSegment
        label="Street Water"
        value={filters.streetWater}
        onChange={(value) => onChange((current) => ({ ...current, streetWater: value }))}
      />
      <BooleanSegment
        label="Most Recent"
        value={filters.mostRecent}
        onChange={(value) => onChange((current) => ({ ...current, mostRecent: value }))}
      />

      {compactHistoryTableFilters ? (
        <div className="asset-range-group">
          {HISTORY_GRAPH_DELTA_FILTERS.map((filter) => (
            <SliderRangeFilter
              bounds={sourceOptions?.numeric_ranges?.[filter.column]}
              defaultMax={sourceOptions?.numeric_ranges?.[filter.column]?.max ?? filter.defaultMax}
              defaultMin={sourceOptions?.numeric_ranges?.[filter.column]?.min ?? filter.defaultMin}
              key={filter.rangeKey}
              label={filter.label}
              onChange={onChange}
              range={filters.numeric[filter.rangeKey]}
              rangeKey={filter.rangeKey}
            />
          ))}
        </div>
      ) : (
        <div className="asset-range-group">
          {historyGraphBothFilters ? (
            HISTORY_GRAPH_DELTA_FILTERS.map((filter) => (
              <SliderRangeFilter
                bounds={sourceOptions?.numeric_ranges?.[filter.column]}
                defaultMax={filter.defaultMax}
                defaultMin={filter.defaultMin}
                key={filter.rangeKey}
                label={filter.label}
                onChange={onChange}
                range={filters.numeric[filter.rangeKey]}
                rangeKey={filter.rangeKey}
              />
            ))
          ) : (
            <>
              {FACILITY_AGGREGATE_RANGE_FILTERS.map((filter) => {
                const bounds = sourceOptions?.numeric_ranges?.[filter.column]
                return (
                  <SliderRangeFilter
                    bounds={bounds}
                    defaultMax={bounds?.max ?? filter.fallbackMax}
                    defaultMin={bounds?.min ?? filter.fallbackMin}
                    key={filter.rangeKey}
                    label={filter.label}
                    onChange={onChange}
                    range={filters.numeric[filter.rangeKey]}
                    rangeKey={filter.rangeKey}
                    step={filter.step}
                  />
                )
              })}
              {source === 'pipes' ? (
                <SliderRangeFilter
                  bounds={sourceOptions?.numeric_ranges?.Pipe_Size}
                  defaultMax={sourceOptions?.numeric_ranges?.Pipe_Size?.max ?? 100}
                  defaultMin={sourceOptions?.numeric_ranges?.Pipe_Size?.min ?? 0}
                  formatValue={(value) => String(Math.round(value))}
                  label="Pipe Size"
                  onChange={onChange}
                  range={filters.numeric.pipe_size}
                  rangeKey="pipe_size"
                  step="1"
                />
              ) : null}
            </>
          )}
        </div>
      )}

      {showSpatialIntersections ? (
        <div className="filter-section">
          <label>Spatial Intersections</label>
          <div className="asset-flag-list">
            {activeFlags.map((flag) => (
              <label className="asset-flag-row" key={flag}>
                <Checkbox
                  checked={filters.flags[flag] === 'true'}
                  onCheckedChange={(checked) =>
                    onChange((current) => ({
                      ...current,
                      flags: {
                        ...current.flags,
                        [flag]: checked === true ? 'true' : 'all',
                      },
                    }))
                  }
                />
                <span>{flag.replaceAll('_', ' ')}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <Button className="clear-button" onClick={onClear} type="button" variant="outline">
        <X size={14} />
        Reset filters
      </Button>
    </div>
  )
}

function BooleanSegment({
  label,
  onChange,
  value,
}: {
  label: string
  onChange: (value: BooleanFilterValue) => void
  value: BooleanFilterValue
}) {
  return (
    <div className="boolean-filter">
      <span>{label}</span>
      <div className="check-grid">
        {[
          ['all', 'All'],
          ['true', 'Yes'],
          ['false', 'No'],
        ].map(([key, text]) => (
          <button
            className={value === key ? 'active' : ''}
            key={key}
            onClick={() => onChange(key as BooleanFilterValue)}
            type="button"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function MaterialMultiSelectFilter({
  materials,
  onChange,
  selected,
}: {
  materials: CellValue[]
  onChange: FilterUpdater
  selected: string[]
}) {
  function toggle(value: string, checked: boolean) {
    onChange((current) => {
      const nextValues = checked
        ? Array.from(new Set([...current.material, value]))
        : current.material.filter((item) => item !== value)
      return { ...current, material: nextValues }
    })
  }

  return (
    <div className="filter-section">
      <div className="asset-section-title-row">
        <label>Material</label>
        <span>{selected.length ? `${selected.length} selected` : 'All'}</span>
      </div>
      <div className="asset-filter-checklist">
        {materials.map((value) => {
          const text = String(value)
          return (
            <label key={text}>
              <Checkbox checked={selected.includes(text)} onCheckedChange={(checked) => toggle(text, checked === true)} />
              <span>{text || 'Blank'}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function sliderText(value: number) {
  return value.toFixed(1)
}

function SliderRangeFilter({
  bounds,
  defaultMax,
  defaultMin,
  formatValue = sliderText,
  label,
  onChange,
  range,
  rangeKey,
  step = '0.1',
}: {
  bounds?: { min: number | null; max: number | null }
  defaultMax: number
  defaultMin: number
  formatValue?: (value: number) => string
  label: string
  onChange: FilterUpdater
  range: { min: string; max: string }
  rangeKey: string
  step?: string
}) {
  const minBound = Number.isFinite(bounds?.min) ? Number(bounds?.min) : defaultMin
  const maxBound = Number.isFinite(bounds?.max) ? Number(bounds?.max) : defaultMax
  const canSlide = maxBound > minBound
  const rawMin = range.min === '' ? defaultMin : Number(range.min)
  const rawMax = range.max === '' ? defaultMax : Number(range.max)
  const sliderMinValue = Number.isFinite(rawMin) ? Math.min(Math.max(rawMin, minBound), maxBound) : defaultMin
  const sliderMaxValue = Number.isFinite(rawMax) ? Math.max(Math.min(rawMax, maxBound), minBound) : defaultMax
  const selectedMinValue = Math.min(sliderMinValue, sliderMaxValue)
  const selectedMaxValue = Math.max(sliderMinValue, sliderMaxValue)
  const minPercent = canSlide ? ((selectedMinValue - minBound) / (maxBound - minBound)) * 100 : 0
  const maxPercent = canSlide ? ((selectedMaxValue - minBound) / (maxBound - minBound)) * 100 : 100

  function setRange(next: { min?: string; max?: string }) {
    onChange((current) => ({
      ...current,
      numeric: {
        ...current.numeric,
        [rangeKey]: {
          min: next.min ?? current.numeric[rangeKey]?.min ?? '',
          max: next.max ?? current.numeric[rangeKey]?.max ?? '',
        },
      },
    }))
  }

  return (
    <div className="range-filter asset-range-filter asset-slider-range-filter">
      <span>{label}</span>
      <div className="asset-slider-range-readout">
        <strong>{formatValue(selectedMinValue)}</strong>
        <strong>{formatValue(selectedMaxValue)}</strong>
      </div>
      <div
        className="asset-dual-range"
        style={{ '--min-pct': `${minPercent}%`, '--max-pct': `${maxPercent}%` } as CSSProperties}
      >
        <input
          aria-label={`${label} minimum`}
          className="asset-dual-range-input"
          disabled={!canSlide}
          max={maxBound}
          min={minBound}
          onChange={(event) => setRange({ min: formatValue(Math.min(Number(event.target.value), selectedMaxValue)) })}
          step={step}
          type="range"
          value={selectedMinValue}
        />
        <input
          aria-label={`${label} maximum`}
          className="asset-dual-range-input"
          disabled={!canSlide}
          max={maxBound}
          min={minBound}
          onChange={(event) => setRange({ max: formatValue(Math.max(Number(event.target.value), selectedMinValue)) })}
          step={step}
          type="range"
          value={selectedMaxValue}
        />
      </div>
    </div>
  )
}
