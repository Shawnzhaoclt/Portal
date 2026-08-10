import { formatDateTime } from './dateTime'
import { downloadBytes } from './fileDownload'

export const EXCEL_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type PortalExcelValue = string | number | boolean | null | undefined

export type PortalExcelCell = {
  value: PortalExcelValue
  hyperlink?: string | null
}

export type PortalExcelColumn = {
  heading: string
  width?: number
  minWidth?: number
  maxWidth?: number
}

export type PortalExcelRow = {
  cells: Array<PortalExcelCell | PortalExcelValue>
  kind?: 'data' | 'total'
}

export type PortalExcelWorkbookOptions = {
  title: string
  sheetName: string
  columns: PortalExcelColumn[]
  rows: PortalExcelRow[]
  metadata?: string[]
  generatedAt?: Date
  autoFilter?: boolean
}

type PackageFile = { name: string; content: string }
type HyperlinkRelationship = { id: string; target: string }

export function escapeExcelXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function excelColumnLetter(index: number) {
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
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function concatBytes(chunks: Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function zipDateTime(date: Date) {
  return {
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

export function createExcelZip(files: PackageFile[]) {
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
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, offset - centralOffset, true)
  endView.setUint32(16, centralOffset, true)
  return concatBytes([...localChunks, ...centralChunks, end])
}

export const PORTAL_EXCEL_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="5">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Aptos"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/></font>
    <font><b/><sz val="11"/><color rgb="FF0B3558"/><name val="Aptos"/></font>
    <font><i/><sz val="10"/><color rgb="FF5B6B80"/><name val="Aptos"/></font>
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
    <border><left style="thin"><color rgb="FFB7C7D8"/></left><right style="thin"><color rgb="FFB7C7D8"/></right><top style="thin"><color rgb="FFB7C7D8"/></top><bottom style="thin"><color rgb="FFB7C7D8"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

export function packagePortalExcelWorksheet(
  sheetName: string,
  worksheet: string,
  hyperlinkRelationships: HyperlinkRelationship[] = [],
) {
  const safeSheetName = sheetName.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Export'
  const files: PackageFile[] = [
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
  <sheets><sheet name="${escapeExcelXml(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets>
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
    { name: 'xl/styles.xml', content: PORTAL_EXCEL_STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', content: worksheet },
  ]

  if (hyperlinkRelationships.length) {
    files.push({
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${hyperlinkRelationships.map((link) => `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeExcelXml(link.target)}" TargetMode="External"/>`).join('\n  ')}
</Relationships>`,
    })
  }
  return createExcelZip(files)
}

function normalizedCell(value: PortalExcelCell | PortalExcelValue): PortalExcelCell {
  if (value !== null && typeof value === 'object') return value
  return { value }
}

function visibleText(value: PortalExcelValue) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function safeSpreadsheetText(value: PortalExcelValue) {
  const text = visibleText(value)
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function xlsxCell(ref: string, source: PortalExcelCell, style: number) {
  const value = source.value
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${style}"/>`
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`
  const text = safeSpreadsheetText(value)
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeExcelXml(text)}</t></is></c>`
}

export function createPortalExcelWorkbook(options: PortalExcelWorkbookOptions) {
  if (!options.columns.length) throw new Error('At least one Excel column is required.')
  const metadata = options.metadata ?? [
    `Generated at ${formatDateTime(options.generatedAt ?? new Date())} | ${options.rows.length.toLocaleString()} ${options.rows.length === 1 ? 'record' : 'records'}`,
  ]
  const headerRowIndex = metadata.length + 2
  const firstDataRowIndex = headerRowIndex + 1
  const lastColumnLetter = excelColumnLetter(options.columns.length - 1)
  const lastRowIndex = Math.max(headerRowIndex, firstDataRowIndex + options.rows.length - 1)
  const hyperlinks: HyperlinkRelationship[] = []
  const hyperlinkRefs: Array<{ ref: string; relationshipId: string }> = []
  const widths = options.columns.map((column, columnIndex) => {
    if (column.width !== undefined) return column.width
    const longest = options.rows.reduce((length, row) => {
      const cell = normalizedCell(row.cells[columnIndex])
      return Math.max(length, visibleText(cell.value).length)
    }, column.heading.length)
    return Math.min(Math.max(longest + 2, column.minWidth ?? 10), column.maxWidth ?? 38)
  })
  const columnXml = `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.max(8, Math.min(width, 60)).toFixed(1)}" customWidth="1"/>`).join('')}</cols>`
  const titleCells = options.columns.map((_, index) => {
    const ref = `${excelColumnLetter(index)}1`
    return index === 0 ? xlsxCell(ref, { value: options.title }, 2) : `<c r="${ref}" s="2"/>`
  }).join('')
  const metadataRows = metadata.map((text, metadataIndex) => {
    const rowIndex = metadataIndex + 2
    const cells = options.columns.map((_, columnIndex) => {
      const ref = `${excelColumnLetter(columnIndex)}${rowIndex}`
      return columnIndex === 0 ? xlsxCell(ref, { value: text }, 6) : `<c r="${ref}" s="6"/>`
    }).join('')
    return `<row r="${rowIndex}" ht="20" customHeight="1">${cells}</row>`
  }).join('\n    ')
  const headerCells = options.columns.map((column, index) => xlsxCell(`${excelColumnLetter(index)}${headerRowIndex}`, { value: column.heading }, 3)).join('')
  const bodyRows = options.rows.map((row, rowIndex) => {
    const sheetRowIndex = firstDataRowIndex + rowIndex
    const cells = options.columns.map((_, columnIndex) => {
      const ref = `${excelColumnLetter(columnIndex)}${sheetRowIndex}`
      const cell = normalizedCell(row.cells[columnIndex])
      const banded = rowIndex % 2 === 1
      const style = row.kind === 'total' ? 7 : cell.hyperlink ? (banded ? 5 : 1) : (banded ? 4 : 0)
      if (cell.hyperlink) {
        const relationshipId = `rId${hyperlinks.length + 1}`
        hyperlinks.push({ id: relationshipId, target: cell.hyperlink })
        hyperlinkRefs.push({ ref, relationshipId })
      }
      return xlsxCell(ref, cell, style)
    }).join('')
    return `<row r="${sheetRowIndex}">${cells}</row>`
  }).join('\n    ')
  const mergeRefs = [`A1:${lastColumnLetter}1`, ...metadata.map((_, index) => `A${index + 2}:${lastColumnLetter}${index + 2}`)]
  const hyperlinkXml = hyperlinkRefs.length
    ? `<hyperlinks>${hyperlinkRefs.map((link) => `<hyperlink ref="${link.ref}" r:id="${link.relationshipId}"/>`).join('')}</hyperlinks>`
    : ''
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastColumnLetter}${lastRowIndex}"/>
  <sheetViews><sheetView showGridLines="0" zoomScale="90" workbookViewId="0"><pane ySplit="${headerRowIndex}" topLeftCell="A${firstDataRowIndex}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${columnXml}
  <sheetData>
    <row r="1" ht="28" customHeight="1">${titleCells}</row>
    ${metadataRows}
    <row r="${headerRowIndex}" ht="25" customHeight="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
  ${options.autoFilter === false ? '' : `<autoFilter ref="A${headerRowIndex}:${lastColumnLetter}${lastRowIndex}"/>`}
  <mergeCells count="${mergeRefs.length}">${mergeRefs.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>
  ${hyperlinkXml}
  <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>
</worksheet>`
  return packagePortalExcelWorksheet(options.sheetName, worksheet, hyperlinks)
}

export function downloadExcelWorkbook(workbook: Uint8Array, fileName: string) {
  const payload = new ArrayBuffer(workbook.byteLength)
  new Uint8Array(payload).set(workbook)
  return downloadBytes(payload, EXCEL_MEDIA_TYPE, fileName, { openInExcel: true })
}
