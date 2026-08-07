export type DateTimeValue = Date | number | string

function parseDateTime(value: DateTimeValue): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const text = value.trim()
  if (!text) return null

  // Date-only values are business dates, not UTC instants. Construct them in
  // the workstation's local timezone so the displayed day cannot shift.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    const parsed = new Date(Number(year), Number(month) - 1, Number(day))
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  // Python ISO timestamps may contain microseconds. JavaScript dates display
  // only to seconds, so keep milliseconds at most before parsing.
  const normalized = text
    .replace(' ', 'T')
    .replace(/\.(\d{3})\d+/, '.$1')
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatDateTime(value: DateTimeValue | null | undefined, fallback = '-') {
  if (value === null || value === undefined) return fallback
  const parsed = parseDateTime(value)
  return parsed ? parsed.toLocaleString() : String(value)
}

export function formatDateOnly(value: DateTimeValue | null | undefined, fallback = '-') {
  if (value === null || value === undefined) return fallback
  const parsed = parseDateTime(value)
  return parsed ? parsed.toLocaleDateString() : String(value)
}

export function formatMonthYear(value: DateTimeValue | null | undefined, fallback = '-') {
  if (value === null || value === undefined) return fallback
  const parsed = parseDateTime(value)
  return parsed
    ? new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(parsed)
    : String(value)
}

export function formatLocalClock(totalMinutes: number, fallback = '-') {
  if (!Number.isInteger(totalMinutes) || totalMinutes < 0 || totalMinutes > 1439) return fallback
  const date = new Date()
  date.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0)
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function formatScheduleLabel(value: string | null | undefined, fallback = '-') {
  if (value === null || value === undefined || !value.trim()) return fallback

  return value.replace(/\b(\d{1,2}):([0-5]\d)\b/g, (match, hourText, minuteText, offset, source) => {
    const after = source.slice(Number(offset) + match.length)
    if (/^\s*(?:AM|PM)\b/i.test(after)) return match

    const formatted = formatLocalClock(Number(hourText) * 60 + Number(minuteText), match)
    return formatted
  })
}

export function todayIsoDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
