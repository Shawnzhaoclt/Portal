import { formatDateOnly } from '../../lib/dateTime'

export const INSPECTION_GROUP_DAY_WINDOW = 1
const DAY_IN_MS = 24 * 60 * 60 * 1000

export type InspectionDateOption = {
  key: string
  label: string
  dateKeys: string[]
}

export function inspectionDateKey(value: unknown) {
  const text = value == null ? '' : String(value).trim()
  if (!text || text === '-') return ''
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

export function inspectionDateKeysFromOption(optionKey: string) {
  return optionKey.split('|').filter(Boolean)
}

function dateTime(key: string) {
  const date = new Date(`${key}T00:00:00`)
  return Number.isNaN(date.getTime()) ? Number.NaN : date.getTime()
}

function periodLabel(dateKeys: string[]) {
  if (dateKeys.length === 0) return '-'
  const keys = [...dateKeys].sort((left, right) => left.localeCompare(right))
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (first === last) return formatDateOnly(first, first)
  return `${formatDateOnly(first, first)} - ${formatDateOnly(last, last)}`
}

export function inspectionDateOptions(values: unknown[]): InspectionDateOption[] {
  const descendingKeys = [...new Set(values.map(inspectionDateKey).filter(Boolean))]
    .sort((left, right) => right.localeCompare(left))
  const options: InspectionDateOption[] = []
  let groupKeys: string[] = []
  let newestKey = ''

  const appendGroup = () => {
    if (!groupKeys.length) return
    options.push({ key: groupKeys.join('|'), label: periodLabel(groupKeys), dateKeys: groupKeys })
  }

  for (const dateKey of descendingKeys) {
    if (!groupKeys.length) {
      groupKeys = [dateKey]
      newestKey = dateKey
      continue
    }
    const dayDifference = Math.abs(dateTime(newestKey) - dateTime(dateKey)) / DAY_IN_MS
    if (Number.isFinite(dayDifference) && dayDifference <= INSPECTION_GROUP_DAY_WINDOW) {
      groupKeys.push(dateKey)
      continue
    }
    appendGroup()
    groupKeys = [dateKey]
    newestKey = dateKey
  }
  appendGroup()
  return options
}
