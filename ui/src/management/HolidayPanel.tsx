import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  CalendarDays,
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDateOnly, formatDateTime } from '../lib/dateTime'
import { appConfirm } from '../components/messageDialogService'
import {
  createHoliday,
  createHolidayCalendar,
  deleteHoliday,
  deleteHolidayCalendar,
  fetchHolidayCalendar,
  fetchHolidayCalendars,
  updateHoliday,
  updateHolidayCalendar,
  validateHolidayCalendar,
  type HolidayCalendar,
  type HolidayCalendarDetail,
  type HolidayEntry,
  type HolidaySavePayload,
  type HolidayValidationResult,
} from './api'

const EMPTY_HOLIDAY: HolidaySavePayload = {
  holiday_name: '',
  holiday_date: '',
  holiday_hours: 8,
  day_type: 'full_day',
  applies_to_weekly_target: true,
  extends_deliverable_deadline: true,
  is_active: true,
  notes: '',
}

const EMPTY_CALENDAR_FORM = {
  calendar_year: new Date().getFullYear(),
  label: '',
  notes: '',
  copy_from_calendar_id: '',
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return '-'
  return formatDateTime(value, value)
}

function dateLabel(value: string) {
  return formatDateOnly(value, value)
}

export default function HolidayPanel() {
  const [calendars, setCalendars] = useState<HolidayCalendar[]>([])
  const [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [detail, setDetail] = useState<HolidayCalendarDetail | null>(null)
  const [validation, setValidation] = useState<HolidayValidationResult | null>(null)
  const [calendarForm, setCalendarForm] = useState(EMPTY_CALENDAR_FORM)
  const [calendarModal, setCalendarModal] = useState<'create' | 'edit' | null>(null)
  const [holidayForm, setHolidayForm] = useState<HolidaySavePayload>(EMPTY_HOLIDAY)
  const [editingHoliday, setEditingHoliday] = useState<HolidayEntry | null>(null)
  const [holidayModalOpen, setHolidayModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const selectedCalendar = detail?.calendar ?? null
  const isEditable = Boolean(selectedCalendar)
  const calendarOptions = useMemo(
    () =>
      calendars.map((calendar) => ({
        value: calendar.calendar_id,
        label: String(calendar.calendar_year),
      })),
    [calendars],
  )

  async function loadDetail(calendarId: string) {
    if (!calendarId) {
      setDetail(null)
      setValidation(null)
      return
    }
    const response = await fetchHolidayCalendar(calendarId)
    setDetail(response)
    setValidation(response.validation)
  }

  async function loadCalendars(preferredCalendarId?: string) {
    const response = await fetchHolidayCalendars()
    setCalendars(response.calendars)
    const preferred = preferredCalendarId || selectedCalendarId
    const nextCalendarId = response.calendars.some((calendar) => calendar.calendar_id === preferred)
      ? preferred
      : response.calendars[0]?.calendar_id ?? ''
    setSelectedCalendarId(nextCalendarId)
    await loadDetail(nextCalendarId)
  }

  useEffect(() => {
    void loadCalendars().catch((error) => {
      toast.error(error instanceof Error ? error.message : 'Could not load holiday calendars.')
    })
  }, [])

  async function runAction(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The holiday calendar action failed.')
    } finally {
      setBusy(false)
    }
  }

  function openNewCalendar() {
    setCalendarForm({
      ...EMPTY_CALENDAR_FORM,
      calendar_year: new Date().getFullYear(),
    })
    setCalendarModal('create')
  }

  function openCalendarDetails() {
    if (!selectedCalendar) return
    setCalendarForm({
      calendar_year: selectedCalendar.calendar_year,
      label: selectedCalendar.label,
      notes: selectedCalendar.notes ?? '',
      copy_from_calendar_id: '',
    })
    setCalendarModal('edit')
  }

  async function submitCalendar(event: FormEvent) {
    event.preventDefault()
    await runAction(async () => {
      if (calendarModal === 'edit' && selectedCalendar) {
        await updateHolidayCalendar(selectedCalendar.calendar_id, {
          label: calendarForm.label,
          notes: calendarForm.notes,
        })
        await loadCalendars(selectedCalendar.calendar_id)
        toast.success('Holiday calendar details updated.')
      } else {
        const response = await createHolidayCalendar({
          calendar_year: calendarForm.calendar_year,
          label: calendarForm.label || null,
          notes: calendarForm.notes || null,
          copy_from_calendar_id: calendarForm.copy_from_calendar_id || null,
        })
        await loadCalendars(response.calendar.calendar_id)
        toast.success('Holiday calendar created.')
      }
      setCalendarModal(null)
    })
  }

  function openHolidayEditor(holiday?: HolidayEntry) {
    setEditingHoliday(holiday ?? null)
    setHolidayForm(
      holiday
        ? {
            holiday_name: holiday.holiday_name,
            holiday_date: holiday.holiday_date,
            holiday_hours: holiday.holiday_hours,
            day_type: holiday.day_type,
            applies_to_weekly_target: holiday.applies_to_weekly_target,
            extends_deliverable_deadline: holiday.extends_deliverable_deadline,
            is_active: holiday.is_active,
            notes: holiday.notes ?? '',
          }
        : { ...EMPTY_HOLIDAY },
    )
    setHolidayModalOpen(true)
  }

  async function submitHoliday(event: FormEvent) {
    event.preventDefault()
    if (!selectedCalendar) return
    await runAction(async () => {
      if (editingHoliday) {
        await updateHoliday(selectedCalendar.calendar_id, editingHoliday.holiday_id, holidayForm)
        toast.success('Holiday updated.')
      } else {
        await createHoliday(selectedCalendar.calendar_id, holidayForm)
        toast.success('Holiday added.')
      }
      setHolidayModalOpen(false)
      setEditingHoliday(null)
      await loadCalendars(selectedCalendar.calendar_id)
    })
  }

  async function handleDeleteHoliday(holiday: HolidayEntry) {
    if (!selectedCalendar || !(await appConfirm(
      `Delete ${holiday.holiday_name} from this calendar?`,
      { title: 'Delete holiday', kind: 'danger', confirmLabel: 'Delete' },
    ))) return
    await runAction(async () => {
      await deleteHoliday(selectedCalendar.calendar_id, holiday.holiday_id)
      await loadCalendars(selectedCalendar.calendar_id)
      toast.success('Holiday deleted.')
    })
  }

  async function handleValidate() {
    if (!selectedCalendar) return
    await runAction(async () => {
      const result = await validateHolidayCalendar(selectedCalendar.calendar_id)
      setValidation(result)
      if (result.valid) toast.success('Calendar passed validation.')
      else toast.error('Calendar has validation errors.')
    })
  }

  async function handleDeleteCalendar() {
    if (!selectedCalendar) return
    if (
      !(await appConfirm(
        `Delete the ${selectedCalendar.calendar_year} holiday calendar and all ${detail?.holidays.length ?? 0} holidays? This cannot be undone.`,
        { title: 'Delete holiday calendar', kind: 'danger', confirmLabel: 'Delete calendar' },
      ))
    ) {
      return
    }
    await runAction(async () => {
      await deleteHolidayCalendar(selectedCalendar.calendar_id)
      setSelectedCalendarId('')
      await loadCalendars()
      toast.success(`${selectedCalendar.calendar_year} holiday calendar deleted.`)
    })
  }

  return (
    <>
      <section className="management-panel holiday-panel">
        <div className="management-panel-heading">
          <div>
            <h2>City-Observed Holidays</h2>
            <span>Maintain one authoritative holiday calendar for each year</span>
          </div>
          <div className="management-panel-heading-actions">
            <button type="button" disabled={busy} onClick={() => void runAction(() => loadCalendars())}>
              <RefreshCw size={16} />
              Refresh
            </button>
            <button className="management-primary-button" type="button" disabled={busy} onClick={() => openNewCalendar()}>
              <Plus size={16} />
              New calendar
            </button>
          </div>
        </div>

        <div className="holiday-calendar-toolbar">
          <label>
            <span>Calendar year</span>
            <select
              value={selectedCalendarId}
              onChange={(event) => {
                const calendarId = event.target.value
                setSelectedCalendarId(calendarId)
                void runAction(() => loadDetail(calendarId))
              }}
            >
              {calendarOptions.length ? null : <option value="">No calendars</option>}
              {calendarOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {selectedCalendar ? (
            <div className="holiday-calendar-actions">
              {isEditable ? (
                <button type="button" disabled={busy} onClick={openCalendarDetails}>
                  <Pencil size={15} />
                  Edit details
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={handleValidate}>
                <CheckCircle2 size={15} />
                Validate
              </button>
              <button
                className="holiday-delete-button"
                type="button"
                disabled={busy}
                onClick={() => void handleDeleteCalendar()}
              >
                <Trash2 size={15} />
                Delete year
              </button>
            </div>
          ) : null}
        </div>

        {selectedCalendar ? (
          <>
            <div className="holiday-calendar-summary">
              <div>
                <span>Calendar</span>
                <strong>{selectedCalendar.label}</strong>
              </div>
              <div>
                <span>Year</span>
                <strong>{selectedCalendar.calendar_year}</strong>
              </div>
              <div>
                <span>Holidays</span>
                <strong>{detail?.holidays.length ?? 0}</strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>{formatTimestamp(selectedCalendar.updated_at)}</strong>
              </div>
            </div>

            {validation?.issues.length ? (
              <div className="holiday-validation">
                {validation.issues.map((issue, index) => (
                  <div className={`holiday-validation-${issue.severity}`} key={`${issue.code}-${issue.holiday_id ?? index}`}>
                    <strong>{issue.severity === 'error' ? 'Error' : 'Warning'}</strong>
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="holiday-table-heading">
              <div>
                <h3>Holidays</h3>
                <span>Maintain one approved holiday date for each non-working day.</span>
              </div>
              {isEditable ? (
                <button className="management-primary-button" type="button" disabled={busy} onClick={() => openHolidayEditor()}>
                  <Plus size={15} />
                  Add holiday
                </button>
              ) : null}
            </div>

            <div className="management-table-wrap">
              <table className="holiday-table">
                <thead>
                  <tr>
                    <th>Holiday date</th>
                    <th>Holiday</th>
                    <th>Hours</th>
                    <th>Day type</th>
                    <th>Weekly target</th>
                    <th>Deadline extension</th>
                    <th>Status</th>
                    {isEditable ? <th>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {detail?.holidays.length ? (
                    detail.holidays.map((holiday) => (
                      <tr key={holiday.holiday_id}>
                        <td>{dateLabel(holiday.holiday_date)}</td>
                        <td>
                          <strong>{holiday.holiday_name}</strong>
                          {holiday.notes ? <small>{holiday.notes}</small> : null}
                        </td>
                        <td>{Number(holiday.holiday_hours).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                        <td>{holiday.day_type === 'full_day' ? 'Full day' : 'Partial day'}</td>
                        <td>{holiday.applies_to_weekly_target ? 'Yes' : 'No'}</td>
                        <td>{holiday.extends_deliverable_deadline ? 'Yes' : 'No'}</td>
                        <td>{holiday.is_active ? 'Active' : 'Inactive'}</td>
                        {isEditable ? (
                          <td>
                            <div className="management-row-actions">
                              <button type="button" title="Edit holiday" onClick={() => openHolidayEditor(holiday)}>
                                <Pencil size={14} />
                                Edit
                              </button>
                              <button
                                className="holiday-delete-button"
                                type="button"
                                title="Delete holiday"
                                onClick={() => void handleDeleteHoliday(holiday)}
                              >
                                <Trash2 size={14} />
                                Delete
                              </button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="holiday-empty-state" colSpan={isEditable ? 8 : 7}>
                        <CalendarDays size={22} />
                        No holidays have been added to this calendar.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="holiday-empty-state holiday-empty-panel">
            <CalendarDays size={28} />
            Create a holiday calendar to begin.
          </div>
        )}
      </section>

      {calendarModal ? (
        <div className="management-modal-backdrop" role="presentation">
          <section className="management-modal holiday-modal" role="dialog" aria-modal="true" aria-label="Holiday calendar">
            <div className="management-modal-heading">
              <div>
                <span>{calendarModal === 'create' ? 'Annual calendar' : 'Calendar details'}</span>
                <h3>{calendarModal === 'create' ? 'Create holiday calendar' : 'Edit holiday calendar'}</h3>
              </div>
              <button type="button" title="Close" onClick={() => setCalendarModal(null)}>
                <X size={18} />
              </button>
            </div>
            <form className="management-form management-modal-form holiday-form" onSubmit={submitCalendar}>
              {calendarModal === 'create' ? (
                <label>
                  <span>Calendar year</span>
                  <input
                    min={2000}
                    max={2100}
                    required
                    type="number"
                    value={calendarForm.calendar_year}
                    onChange={(event) => setCalendarForm((current) => ({ ...current, calendar_year: Number(event.target.value) }))}
                  />
                </label>
              ) : null}
              <label>
                <span>Label</span>
                <input
                  required={calendarModal === 'edit'}
                  value={calendarForm.label}
                  placeholder={`${calendarForm.calendar_year} City-Observed Holidays`}
                  onChange={(event) => setCalendarForm((current) => ({ ...current, label: event.target.value }))}
                />
              </label>
              {calendarModal === 'create' ? (
                <label>
                  <span>Copy holidays from</span>
                  <select
                    value={calendarForm.copy_from_calendar_id}
                    onChange={(event) => setCalendarForm((current) => ({ ...current, copy_from_calendar_id: event.target.value }))}
                  >
                    <option value="">Start with an empty calendar</option>
                    {calendarOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                <span>Notes</span>
                <textarea
                  rows={3}
                  value={calendarForm.notes}
                  onChange={(event) => setCalendarForm((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>
              <div className="management-modal-actions">
                <button type="button" onClick={() => setCalendarModal(null)}>
                  Cancel
                </button>
                <button className="management-primary-button" type="submit" disabled={busy}>
                  {calendarModal === 'create' ? 'Create calendar' : 'Save details'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {holidayModalOpen ? (
        <div className="management-modal-backdrop" role="presentation">
          <section className="management-modal holiday-modal holiday-entry-modal" role="dialog" aria-modal="true" aria-label="Holiday">
            <div className="management-modal-heading">
              <div>
                <span>Holiday</span>
                <h3>{editingHoliday ? 'Edit holiday' : 'Add holiday'}</h3>
              </div>
              <button type="button" title="Close" onClick={() => setHolidayModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <form className="management-form management-modal-form holiday-form holiday-entry-form" onSubmit={submitHoliday}>
              <label className="holiday-form-wide">
                <span>Holiday name</span>
                <input
                  required
                  value={holidayForm.holiday_name}
                  onChange={(event) => setHolidayForm((current) => ({ ...current, holiday_name: event.target.value }))}
                />
              </label>
              <label>
                <span>Holiday date</span>
                <input
                  required
                  type="date"
                  value={holidayForm.holiday_date}
                  onChange={(event) => setHolidayForm((current) => ({ ...current, holiday_date: event.target.value }))}
                />
              </label>
              <label>
                <span>Holiday hours</span>
                <input
                  min={0.25}
                  max={24}
                  step={0.25}
                  required
                  type="number"
                  value={holidayForm.holiday_hours}
                  onChange={(event) => setHolidayForm((current) => ({ ...current, holiday_hours: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>Day type</span>
                <select
                  value={holidayForm.day_type}
                  onChange={(event) =>
                    setHolidayForm((current) => ({ ...current, day_type: event.target.value as HolidayEntry['day_type'] }))
                  }
                >
                  <option value="full_day">Full day</option>
                  <option value="partial_day">Partial day</option>
                </select>
              </label>
              <label className="holiday-checkbox">
                <input
                  type="checkbox"
                  checked={holidayForm.applies_to_weekly_target}
                  onChange={(event) =>
                    setHolidayForm((current) => ({ ...current, applies_to_weekly_target: event.target.checked }))
                  }
                />
                <span>Reduces weekly target</span>
              </label>
              <label className="holiday-checkbox">
                <input
                  type="checkbox"
                  checked={holidayForm.extends_deliverable_deadline}
                  onChange={(event) =>
                    setHolidayForm((current) => ({ ...current, extends_deliverable_deadline: event.target.checked }))
                  }
                />
                <span>Extends deliverable deadline</span>
              </label>
              <label className="holiday-checkbox holiday-form-wide">
                <input
                  type="checkbox"
                  checked={holidayForm.is_active}
                  onChange={(event) => setHolidayForm((current) => ({ ...current, is_active: event.target.checked }))}
                />
                <span>Active holiday</span>
              </label>
              <label className="holiday-form-wide">
                <span>Notes</span>
                <textarea
                  rows={3}
                  value={holidayForm.notes ?? ''}
                  onChange={(event) => setHolidayForm((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>
              <div className="management-modal-actions holiday-form-wide">
                <button type="button" onClick={() => setHolidayModalOpen(false)}>
                  Cancel
                </button>
                <button className="management-primary-button" type="submit" disabled={busy}>
                  {editingHoliday ? 'Save holiday' : 'Add holiday'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  )
}
