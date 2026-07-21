import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  Download,
  ExternalLink,
  Search,
  X,
} from 'lucide-react'
import '../critical-team/CriticalTeamDashboard.css'
import './PlanningPendingAifQaTable.css'
import { portalRequestJson } from '../../desktop/request'
import { openExternalUrl } from '../../desktop/runtime'

type CellValue = string | number | boolean | null
type PendingAifRow = Record<string, CellValue> & {
  _links?: Record<string, string>
}

type PendingAifResponse = {
  total: number
  limit: number
  offset: number
  rows: PendingAifRow[]
}

type PendingAifFilterOptions = Record<string, string[]>

type NumberFilterMode = 'any' | 'exact' | 'between' | 'greater' | 'less'
type DateFilterMode = 'any' | 'exact' | 'between' | 'before' | 'after'
type SortDirection = 'asc' | 'desc'

type NumberFilter = {
  mode: NumberFilterMode
  from: string
  to: string
}

type DateFilter = {
  mode: DateFilterMode
  from: string
  to: string
}

type PendingAifColumn = {
  key: string
  label: string
  width: string
  type: 'category' | 'date' | 'number' | 'text'
  link?: boolean
}

const PENDING_AIF_COLUMNS: PendingAifColumn[] = [
  { key: 'inspection_id', label: 'Inspection ID', width: '9%', type: 'number', link: true },
  { key: 'asset_id', label: 'Asset ID', width: '10%', type: 'text' },
  { key: 'inspection_date', label: 'Inspection Date', width: '12%', type: 'date' },
  { key: 'inspection_by', label: 'Inspection By', width: '11%', type: 'category' },
  { key: 'inspection_status', label: 'Inspection Status', width: '10%', type: 'category' },
  { key: 'submit_to', label: 'Submit To', width: '11%', type: 'category' },
  { key: 'team', label: 'Team', width: '11%', type: 'category' },
  { key: 'related_workorder_id', label: 'WorkOrder ID', width: '11%', type: 'number', link: true },
  { key: 'critical_team_status', label: 'Critical Team Status', width: '11%', type: 'category' },
  { key: 'investigation_id', label: 'Investigation ID', width: '9%', type: 'number', link: true },
  { key: 'investigation_status', label: 'Investigation Status', width: '10%', type: 'category' },
]

const NUMBER_FILTER_KEYS = ['inspection_id', 'related_workorder_id', 'investigation_id'] as const
const TEXT_FILTER_KEYS = ['asset_id'] as const
const CATEGORY_FILTER_KEYS = [
  'inspection_by',
  'inspection_status',
  'submit_to',
  'team',
  'critical_team_status',
  'investigation_status',
] as const
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500]
const DEFAULT_SORT = { column: 'inspection_id', direction: 'asc' as SortDirection }
const CRITICAL_TEAM_ONLY_COLUMNS = new Set(['related_workorder_id', 'critical_team_status'])

function createEmptyNumberFilters() {
  return Object.fromEntries(
    NUMBER_FILTER_KEYS.map((key) => [key, { mode: 'any', from: '', to: '' }]),
  ) as Record<(typeof NUMBER_FILTER_KEYS)[number], NumberFilter>
}

function createEmptyTextFilters() {
  return Object.fromEntries(TEXT_FILTER_KEYS.map((key) => [key, ''])) as Record<(typeof TEXT_FILTER_KEYS)[number], string>
}

function createEmptyCategoryFilters() {
  return Object.fromEntries(CATEGORY_FILTER_KEYS.map((key) => [key, ''])) as Record<
    (typeof CATEGORY_FILTER_KEYS)[number],
    string
  >
}

function createEmptyDateFilter(): DateFilter {
  return { mode: 'any', from: '', to: '' }
}

async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const suffix = params && params.size > 0 ? `?${params.toString()}` : ''
  return portalRequestJson<T>(`${path}${suffix}`)
}

function fetchPendingAifFilterOptions() {
  return apiGet<PendingAifFilterOptions>('/api/planning/pending-aif/filter-options')
}

function fetchPendingAifRows({
  categoryFilters,
  dateFilter,
  limit,
  numberFilters,
  offset,
  search,
  sort,
  textFilters,
}: {
  categoryFilters: ReturnType<typeof createEmptyCategoryFilters>
  dateFilter: DateFilter
  limit: number
  numberFilters: ReturnType<typeof createEmptyNumberFilters>
  offset: number
  search: string
  sort: typeof DEFAULT_SORT
  textFilters: ReturnType<typeof createEmptyTextFilters>
}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  params.set('sort_by', sort.column)
  params.set('sort_dir', sort.direction)
  if (search.trim()) params.set('search', search.trim())

  for (const [key, filter] of Object.entries(numberFilters)) {
    if (filter.mode === 'any') continue
    params.set(`${key}_mode`, filter.mode)
    if (filter.from) params.set(`${key}_from`, filter.from)
    if (filter.to) params.set(`${key}_to`, filter.to)
  }

  for (const [key, value] of Object.entries(textFilters)) {
    if (value.trim()) params.set(`${key}_filter`, value.trim())
  }

  for (const [key, value] of Object.entries(categoryFilters)) {
    if (value) params.append(`${key}_filter`, value)
  }

  if (dateFilter.mode !== 'any') {
    params.set('inspection_date_mode', dateFilter.mode)
    if (dateFilter.from) params.set('inspection_date_from', dateFilter.from)
    if (dateFilter.to) params.set('inspection_date_to', dateFilter.to)
  }

  return apiGet<PendingAifResponse>('/api/planning/pending-aif', params)
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return new Intl.NumberFormat().format(value)
}

function cellText(value: CellValue, column: PendingAifColumn) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (column.type === 'number') return String(value).replace(/\.0$/, '')
  if (typeof value === 'number') return formatNumber(value)
  if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  return String(value)
}

function isCriticalTeamRow(row: PendingAifRow) {
  return String(row.team ?? '').trim().toLowerCase() === 'critical team'
}

function visibleCellText(row: PendingAifRow, column: PendingAifColumn) {
  if (CRITICAL_TEAM_ONLY_COLUMNS.has(column.key) && !isCriticalTeamRow(row)) return ''
  return cellText(row[column.key], column)
}

function visibleCellHref(row: PendingAifRow, column: PendingAifColumn) {
  if (!column.link) return ''
  if (CRITICAL_TEAM_ONLY_COLUMNS.has(column.key) && !isCriticalTeamRow(row)) return ''
  return row._links?.[column.key] ?? ''
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

function formatGeneratedAt(date: Date) {
  const parts = [
    date.getMonth() + 1,
    date.getDate(),
    date.getFullYear(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((value, index) => (index === 2 ? String(value) : String(value).padStart(2, '0')))
  return `${parts[0]}-${parts[1]}-${parts[2]}, ${parts[3]}:${parts[4]}:${parts[5]}`
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
    view.setUint16(28, 0, true)
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
    view.setUint16(30, 0, true)
    view.setUint16(32, 0, true)
    view.setUint16(34, 0, true)
    view.setUint16(36, 0, true)
    view.setUint32(38, 0, true)
    view.setUint32(42, entry.offset, true)
    header.set(entry.nameBytes, 46)
    centralChunks.push(header)
    offset += header.length
  }

  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, entries.length, true)
  view.setUint16(10, entries.length, true)
  view.setUint32(12, offset - centralOffset, true)
  view.setUint32(16, centralOffset, true)
  return concatBytes([...localChunks, ...centralChunks, end])
}

function createXlsx(rows: PendingAifRow[]) {
  const hyperlinkRelationships: Array<{ id: string; target: string }> = []
  const hyperlinkRefs: Array<{ ref: string; relationshipId: string }> = []
  const titleRowIndex = 1
  const generatedAtRowIndex = 2
  const headerRowIndex = 3
  const firstDataRowIndex = 4
  const lastColumnLetter = columnLetter(PENDING_AIF_COLUMNS.length - 1)
  const lastRowIndex = Math.max(headerRowIndex, rows.length + firstDataRowIndex - 1)
  const titleText = `Planning Pending AIF QA/QC - ${formatNumber(rows.length)} Pending AIF`
  const generatedAtText = `Generated at ${formatGeneratedAt(new Date())}`
  const columnWidths = PENDING_AIF_COLUMNS.map((column) => {
    const maxContentLength = rows.reduce((maxLength, row) => {
      const text = visibleCellText(row, column)
      return Math.max(maxLength, text.length)
    }, column.label.length)
    return Math.min(Math.max(maxContentLength + 2, column.link ? 12 : 10), 38)
  })
  const columnXml = `<cols>${columnWidths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width.toFixed(1)}" customWidth="1"/>`)
    .join('')}</cols>`
  const titleCells = PENDING_AIF_COLUMNS.map((_, columnIndex) => {
    const ref = `${columnLetter(columnIndex)}${titleRowIndex}`
    return columnIndex === 0
      ? `<c r="${ref}" s="2" t="inlineStr"><is><t>${escapeXml(titleText)}</t></is></c>`
      : `<c r="${ref}" s="2"/>`
  }).join('')
  const generatedAtCells = PENDING_AIF_COLUMNS.map((_, columnIndex) => {
    const ref = `${columnLetter(columnIndex)}${generatedAtRowIndex}`
    return columnIndex === 0
      ? `<c r="${ref}" s="6" t="inlineStr"><is><t>${escapeXml(generatedAtText)}</t></is></c>`
      : `<c r="${ref}" s="6"/>`
  }).join('')
  const headerCells = PENDING_AIF_COLUMNS.map((column, columnIndex) => {
    const ref = `${columnLetter(columnIndex)}${headerRowIndex}`
    return `<c r="${ref}" s="3" t="inlineStr"><is><t>${escapeXml(column.label)}</t></is></c>`
  }).join('')
  const bodyRows = rows
    .map((row, rowIndex) => {
      const sheetRowIndex = rowIndex + firstDataRowIndex
      const isBanded = rowIndex % 2 === 1
      const cells = PENDING_AIF_COLUMNS.map((column, columnIndex) => {
        const ref = `${columnLetter(columnIndex)}${sheetRowIndex}`
        const text = visibleCellText(row, column)
        const href = visibleCellHref(row, column)
        const defaultStyle = isBanded ? 4 : 0
        const hyperlinkStyle = isBanded ? 5 : 1
        if (!text || text === '-') return `<c r="${ref}" s="${defaultStyle}"/>`
        if (href) {
          const relationshipId = `rId${hyperlinkRelationships.length + 1}`
          hyperlinkRelationships.push({ id: relationshipId, target: href })
          hyperlinkRefs.push({ ref, relationshipId })
          return `<c r="${ref}" s="${hyperlinkStyle}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`
        }
        return `<c r="${ref}" s="${defaultStyle}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`
      }).join('')
      return `<row r="${sheetRowIndex}">${cells}</row>`
    })
    .join('')
  const lastCell = `${lastColumnLetter}${lastRowIndex}`
  const hyperlinkXml = hyperlinkRefs.length
    ? `<hyperlinks>${hyperlinkRefs.map((link) => `<hyperlink ref="${link.ref}" r:id="${link.relationshipId}"/>`).join('')}</hyperlinks>`
    : ''
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${columnXml}
  <sheetData>
    <row r="${titleRowIndex}" ht="28" customHeight="1">${titleCells}</row>
    <row r="${generatedAtRowIndex}" ht="20" customHeight="1">${generatedAtCells}</row>
    <row r="${headerRowIndex}" ht="22" customHeight="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
  <autoFilter ref="A${headerRowIndex}:${lastColumnLetter}${lastRowIndex}"/>
  <mergeCells count="2"><mergeCell ref="A1:${lastColumnLetter}1"/><mergeCell ref="A2:${lastColumnLetter}2"/></mergeCells>
  ${hyperlinkXml}
</worksheet>`
  const workbookFiles = [
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
  <sheets><sheet name="Pending AIF QA QC" sheetId="1" r:id="rId1"/></sheets>
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
  <fonts count="5">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF0B3558"/><name val="Calibri"/></font>
    <font><i/><sz val="10"/><color rgb="FF5B6B80"/><name val="Calibri"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F5D8F"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD6E7F2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FA"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFB7C7D8"/></left>
      <right style="thin"><color rgb="FFB7C7D8"/></right>
      <top style="thin"><color rgb="FFB7C7D8"/></top>
      <bottom style="thin"><color rgb="FFB7C7D8"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    },
    { name: 'xl/worksheets/sheet1.xml', content: worksheet },
  ]

  if (hyperlinkRelationships.length > 0) {
    workbookFiles.push({
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${hyperlinkRelationships
    .map(
      (link) =>
        `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(link.target)}" TargetMode="External"/>`,
    )
    .join('\n  ')}
</Relationships>`,
    })
  }

  return createZip(workbookFiles)
}

function downloadRows(rows: PendingAifRow[]) {
  const workbook = createXlsx(rows)
  const blob = new Blob([workbook], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `planning-pending-aif-qa-${new Date().toISOString().slice(0, 10)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function hasActiveFilters(
  search: string,
  numberFilters: ReturnType<typeof createEmptyNumberFilters>,
  textFilters: ReturnType<typeof createEmptyTextFilters>,
  categoryFilters: ReturnType<typeof createEmptyCategoryFilters>,
  dateFilter: DateFilter,
) {
  return (
    Boolean(search.trim()) ||
    Object.values(numberFilters).some((filter) => filter.mode !== 'any' && (filter.from || filter.to)) ||
    Object.values(textFilters).some((value) => value.trim()) ||
    Object.values(categoryFilters).some(Boolean) ||
    (dateFilter.mode !== 'any' && Boolean(dateFilter.from || dateFilter.to))
  )
}

function PlanningPendingAifQaTable() {
  const [rowsResponse, setRowsResponse] = useState<PendingAifResponse | null>(null)
  const [options, setOptions] = useState<PendingAifFilterOptions>({})
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [numberFilters, setNumberFilters] = useState(createEmptyNumberFilters)
  const [textFilters, setTextFilters] = useState(createEmptyTextFilters)
  const [categoryFilters, setCategoryFilters] = useState(createEmptyCategoryFilters)
  const [dateFilter, setDateFilter] = useState(createEmptyDateFilter)
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState(DEFAULT_SORT)
  const [selectedRow, setSelectedRow] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('critical-team-dashboard-active')
    document.body.classList.add('critical-team-dashboard-active')
    return () => {
      document.documentElement.classList.remove('critical-team-dashboard-active')
      document.body.classList.remove('critical-team-dashboard-active')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchPendingAifFilterOptions()
      .then((response) => {
        if (!cancelled) setOptions(response)
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : String(requestError))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPendingAifRows({
      categoryFilters,
      dateFilter,
      limit: pageSize,
      numberFilters,
      offset: (page - 1) * pageSize,
      search,
      sort,
      textFilters,
    })
      .then((response) => {
        if (cancelled) return
        setRowsResponse(response)
        setSelectedRow(null)
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : String(requestError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [categoryFilters, dateFilter, numberFilters, page, pageSize, search, sort, textFilters])

  useEffect(() => {
    const total = rowsResponse?.total ?? 0
    const pageCount = Math.max(1, Math.ceil(total / pageSize))
    if (page > pageCount) setPage(pageCount)
  }, [page, pageSize, rowsResponse?.total])

  const rows = rowsResponse?.rows ?? []
  const total = rowsResponse?.total ?? 0
  const firstRecord = total === 0 ? 0 : (rowsResponse?.offset ?? 0) + 1
  const lastRecord = total === 0 ? 0 : Math.min((rowsResponse?.offset ?? 0) + rows.length, total)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const activeFilters = useMemo(
    () => hasActiveFilters(search, numberFilters, textFilters, categoryFilters, dateFilter),
    [categoryFilters, dateFilter, numberFilters, search, textFilters],
  )

  function updateNumberFilter(column: (typeof NUMBER_FILTER_KEYS)[number], next: Partial<NumberFilter>) {
    setPage(1)
    setNumberFilters((current) => {
      const nextFilter = { ...current[column], ...next }
      if (next.mode === 'any') {
        nextFilter.from = ''
        nextFilter.to = ''
      }
      if (next.mode === 'exact' || next.mode === 'greater' || next.mode === 'less') {
        nextFilter.to = ''
      }
      return { ...current, [column]: nextFilter }
    })
  }

  function updateDateFilter(next: Partial<DateFilter>) {
    setPage(1)
    setDateFilter((current) => {
      const nextFilter = { ...current, ...next }
      if (next.mode === 'any') {
        nextFilter.from = ''
        nextFilter.to = ''
      }
      if (next.mode === 'exact' || next.mode === 'before' || next.mode === 'after') {
        nextFilter.to = ''
      }
      return nextFilter
    })
  }

  function clearFilters() {
    setSearch('')
    setSearchDraft('')
    setNumberFilters(createEmptyNumberFilters())
    setTextFilters(createEmptyTextFilters())
    setCategoryFilters(createEmptyCategoryFilters())
    setDateFilter(createEmptyDateFilter())
    setPage(1)
  }

  function changeSort(column: string) {
    setPage(1)
    setSort((current) => {
      if (current.column === column) {
        return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { column, direction: 'asc' }
    })
  }

  function moveToPage(nextPage: number) {
    setPage(Math.max(1, Math.min(pageCount, nextPage)))
  }

  function rowKey(row: PendingAifRow, index: number) {
    return String(row.inspection_id ?? `${rowsResponse?.offset ?? 0}-${index}`)
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, key: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelectedRow(key)
    }
  }

  async function downloadAllRows() {
    if (total <= 0 || exporting) return
    setError(null)
    setExporting(true)
    try {
      const batchSize = 5000
      const allRows: PendingAifRow[] = []
      let offset = 0
      let expectedTotal = total
      while (offset < expectedTotal) {
        const response = await fetchPendingAifRows({
          categoryFilters,
          dateFilter,
          limit: Math.min(batchSize, Math.max(1, expectedTotal - offset)),
          numberFilters,
          offset,
          search,
          sort,
          textFilters,
        })
        expectedTotal = response.total
        allRows.push(...response.rows)
        if (response.rows.length === 0) break
        offset += response.rows.length
      }
      downloadRows(allRows)
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError))
    } finally {
      setExporting(false)
    }
  }

  function renderColumnFilter(column: PendingAifColumn) {
    if (column.type === 'number') {
      const filter = numberFilters[column.key as (typeof NUMBER_FILTER_KEYS)[number]]
      return (
        <div className="number-filter-cell">
          <select
            className="column-filter-select"
            value={filter.mode}
            onChange={(event) => updateNumberFilter(column.key as (typeof NUMBER_FILTER_KEYS)[number], { mode: event.target.value as NumberFilterMode })}
            aria-label={`${column.label} filter mode`}
          >
            <option value="any">Any number</option>
            <option value="exact">Equals</option>
            <option value="between">Between</option>
            <option value="greater">Greater</option>
            <option value="less">Less</option>
          </select>
          {filter.mode !== 'any' ? (
            <input
              className="number-filter-input"
              inputMode="numeric"
              placeholder="Value"
              value={filter.from}
              onChange={(event) => updateNumberFilter(column.key as (typeof NUMBER_FILTER_KEYS)[number], { from: event.target.value })}
            />
          ) : null}
          {filter.mode === 'between' ? (
            <input
              className="number-filter-input"
              inputMode="numeric"
              placeholder="To"
              value={filter.to}
              onChange={(event) => updateNumberFilter(column.key as (typeof NUMBER_FILTER_KEYS)[number], { to: event.target.value })}
            />
          ) : null}
        </div>
      )
    }

    if (column.type === 'text') {
      return (
        <div className="text-filter-cell">
          <input
            className="text-filter-input"
            placeholder="Search"
            value={textFilters[column.key as (typeof TEXT_FILTER_KEYS)[number]] ?? ''}
            onChange={(event) => {
              setPage(1)
              setTextFilters((current) => ({ ...current, [column.key]: event.target.value }))
            }}
            aria-label={`${column.label} search`}
          />
        </div>
      )
    }

    if (column.type === 'date') {
      return (
        <div className="date-filter-cell">
          <select
            className="column-filter-select"
            value={dateFilter.mode}
            onChange={(event) => updateDateFilter({ mode: event.target.value as DateFilterMode })}
            aria-label="Inspection date filter mode"
          >
            <option value="any">Any date</option>
            <option value="exact">On</option>
            <option value="between">Between</option>
            <option value="before">Before</option>
            <option value="after">After</option>
          </select>
          {dateFilter.mode !== 'any' ? (
            <input
              className="date-picker-trigger"
              type="date"
              value={dateFilter.from}
              onChange={(event) => updateDateFilter({ from: event.target.value })}
            />
          ) : null}
          {dateFilter.mode === 'between' ? (
            <input
              className="date-picker-trigger"
              type="date"
              value={dateFilter.to}
              onChange={(event) => updateDateFilter({ to: event.target.value })}
            />
          ) : null}
        </div>
      )
    }

    if (column.type === 'category') {
      return (
        <select
          className="column-filter-select"
          value={categoryFilters[column.key as (typeof CATEGORY_FILTER_KEYS)[number]] ?? ''}
          onChange={(event) => {
            setPage(1)
            setCategoryFilters((current) => ({ ...current, [column.key]: event.target.value }))
          }}
          aria-label={`${column.label} filter`}
        >
          <option value="">All</option>
          {(options[column.key] ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )
    }

    return null
  }

  return (
    <div className="workbook-shell detail-mode portal-view-mode planning-aif-workbook">
      <main className="sheet-canvas planning-aif-canvas">
        {error ? <div className="error-banner">{error}</div> : null}
        {loading ? <div className="loading-bar">Refreshing pending AIF records</div> : null}

        <section className="sheet-panel table-panel detail-panel planning-aif-panel">
          <div className="panel-header">
            <div>
              <ClipboardCheck size={18} />
              <div>
                <strong>Planning Pending AIF QA/QC</strong>
                <span>Pending Asset Inspection Form records</span>
              </div>
            </div>
            <div className="planning-aif-total" aria-label={`${formatNumber(total)} pending AIF records`}>
              <strong>{formatNumber(total)}</strong>
              <span>Pending AIF</span>
            </div>
          </div>

          <div className="detail-toolbar planning-aif-search-toolbar">
            <form
              className="planning-aif-search"
              onSubmit={(event) => {
                event.preventDefault()
                setPage(1)
                setSearch(searchDraft)
              }}
            >
              <Search size={16} />
              <input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Search inspection, asset, team, workorder, investigator"
                aria-label="Search pending AIF records"
              />
              <button className="export-button planning-aif-search-button" type="submit">
                Search
              </button>
            </form>
          </div>

          <div className="detail-toolbar">
            <div className="records-per-page">
              <span>Records per page</span>
              <select
                className="page-size-select"
                value={pageSize}
                onChange={(event) => {
                  setPage(1)
                  setPageSize(Number(event.target.value))
                }}
                aria-label="Records per page"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
            <div className="detail-toolbar-actions">
              <span>
                {formatNumber(firstRecord)}-{formatNumber(lastRecord)} of {formatNumber(total)}
              </span>
              <button className="export-button" type="button" disabled={total === 0 || exporting} onClick={downloadAllRows}>
                <Download size={14} />
                {exporting ? 'Preparing...' : 'Download Excel'}
              </button>
              <button className="clear-table-filters" type="button" disabled={!activeFilters} onClick={clearFilters}>
                <X size={14} />
                Clear column filters
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="detail-table planning-aif-table">
              <colgroup>
                {PENDING_AIF_COLUMNS.map((column) => (
                  <col key={column.key} style={{ width: column.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {PENDING_AIF_COLUMNS.map((column) => (
                    <th key={column.key} aria-sort={sort.column === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        className={sort.column === column.key ? 'sort-button active' : 'sort-button'}
                        type="button"
                        title={`Sort by ${column.label}`}
                        onClick={() => changeSort(column.key)}
                      >
                        <span>{column.label}</span>
                        {sort.column === column.key ? (
                          sort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />
                        ) : (
                          <ArrowDownUp size={13} />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
                <tr className="column-filter-row">
                  {PENDING_AIF_COLUMNS.map((column) => (
                    <th key={column.key}>{renderColumnFilter(column)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const key = rowKey(row, index)
                  return (
                    <tr
                      className={selectedRow === key ? 'selected-row' : undefined}
                      key={key}
                      tabIndex={0}
                      onClick={() => setSelectedRow(key)}
                      onKeyDown={(event) => handleRowKeyDown(event, key)}
                    >
                      {PENDING_AIF_COLUMNS.map((column) => {
                        const text = visibleCellText(row, column)
                        const href = visibleCellHref(row, column)
                        return (
                          <td key={column.key} title={text}>
                            {href && text !== '-' ? (
                              <a
                                className="planning-aif-table-link"
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  void openExternalUrl(href).catch((error) => {
                                    toast.error(error instanceof Error ? error.message : 'Could not open the link.')
                                  })
                                }}
                              >
                                {text}
                                <ExternalLink size={12} aria-hidden="true" />
                              </a>
                            ) : (
                              text
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td className="empty-row" colSpan={PENDING_AIF_COLUMNS.length}>
                      No pending AIF records match the current filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="pagination" aria-label="Pending AIF pagination">
            <span>
              Page {formatNumber(total === 0 ? 1 : page)} of {formatNumber(pageCount)}
            </span>
            <div className="pagination-actions">
              <button type="button" title="First page" aria-label="First page" disabled={page <= 1} onClick={() => moveToPage(1)}>
                <ChevronsLeft size={16} />
              </button>
              <button type="button" title="Previous page" aria-label="Previous page" disabled={page <= 1} onClick={() => moveToPage(page - 1)}>
                <ChevronLeft size={16} />
              </button>
              <button type="button" title="Next page" aria-label="Next page" disabled={page >= pageCount || total === 0} onClick={() => moveToPage(page + 1)}>
                <ChevronRight size={16} />
              </button>
              <button type="button" title="Last page" aria-label="Last page" disabled={page >= pageCount || total === 0} onClick={() => moveToPage(pageCount)}>
                <ChevronsRight size={16} />
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default PlanningPendingAifQaTable
