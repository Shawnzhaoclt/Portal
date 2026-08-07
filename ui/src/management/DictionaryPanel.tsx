import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDateTime } from '../lib/dateTime'
import {
  createDictionary,
  createDictionaryItem,
  fetchDictionaries,
  fetchDictionaryItems,
  reorderDictionaryItems,
  updateDictionary,
  updateDictionaryItem,
  type CodeDictionary,
  type CodeDictionaryItem,
} from './api'

type DictionaryEditorMode = 'create' | 'edit' | null
type ItemEditorMode = 'create' | 'edit' | null
type StatusFilter = 'all' | 'active' | 'inactive'

const EMPTY_DICTIONARY_FORM = {
  name: '',
  dictionary_key: '',
  description: '',
}

const EMPTY_ITEM_FORM = {
  label: '',
  item_code: '',
  sort_order: 1,
}

function suggestedCode(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function formatTimestamp(value: string) {
  return formatDateTime(value, value)
}

export default function DictionaryPanel() {
  const [dictionaries, setDictionaries] = useState<CodeDictionary[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [items, setItems] = useState<CodeDictionaryItem[]>([])
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dictionaryEditor, setDictionaryEditor] = useState<DictionaryEditorMode>(null)
  const [itemEditor, setItemEditor] = useState<ItemEditorMode>(null)
  const [editingItem, setEditingItem] = useState<CodeDictionaryItem | null>(null)
  const [dictionaryForm, setDictionaryForm] = useState(EMPTY_DICTIONARY_FORM)
  const [itemForm, setItemForm] = useState(EMPTY_ITEM_FORM)
  const [busy, setBusy] = useState(false)

  const selectedDictionary = useMemo(
    () => dictionaries.find((dictionary) => dictionary.dictionary_key === selectedKey) ?? null,
    [dictionaries, selectedKey],
  )

  const sortedItems = useMemo(
    () => [...items].sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label)),
    [items],
  )

  const visibleItems = useMemo(() => {
    const term = searchText.trim().toLowerCase()
    return sortedItems.filter((item) => {
      if (statusFilter === 'active' && !item.is_active) return false
      if (statusFilter === 'inactive' && item.is_active) return false
      return !term || item.label.toLowerCase().includes(term) || item.item_code.toLowerCase().includes(term)
    })
  }, [searchText, sortedItems, statusFilter])

  async function loadDictionaries(preferredKey?: string) {
    const response = await fetchDictionaries()
    setDictionaries(response.dictionaries)
    setSelectedKey((current) => {
      const requested = preferredKey || current
      if (requested && response.dictionaries.some((dictionary) => dictionary.dictionary_key === requested)) {
        return requested
      }
      return response.dictionaries[0]?.dictionary_key ?? ''
    })
  }

  async function loadItems(dictionaryKey = selectedKey) {
    if (!dictionaryKey) {
      setItems([])
      return
    }
    const response = await fetchDictionaryItems(dictionaryKey)
    setItems(response.items)
    setDictionaries((current) => current.map((dictionary) => (
      dictionary.dictionary_key === dictionaryKey ? response.dictionary : dictionary
    )))
  }

  async function runAction(action: () => Promise<void>, fallback: string) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void loadDictionaries().catch((error) => {
      toast.error(error instanceof Error ? error.message : 'Could not load dictionaries.')
    })
  }, [])

  useEffect(() => {
    void loadItems(selectedKey).catch((error) => {
      toast.error(error instanceof Error ? error.message : 'Could not load dictionary values.')
    })
  }, [selectedKey])

  function openCreateDictionary() {
    setDictionaryForm(EMPTY_DICTIONARY_FORM)
    setDictionaryEditor('create')
  }

  function openEditDictionary() {
    if (!selectedDictionary) return
    setDictionaryForm({
      name: selectedDictionary.name,
      dictionary_key: selectedDictionary.dictionary_key,
      description: selectedDictionary.description ?? '',
    })
    setDictionaryEditor('edit')
  }

  async function submitDictionary(event: FormEvent) {
    event.preventDefault()
    const name = dictionaryForm.name.trim()
    if (!name) return
    await runAction(async () => {
      if (dictionaryEditor === 'edit' && selectedDictionary) {
        await updateDictionary(selectedDictionary.dictionary_key, {
          name,
          description: dictionaryForm.description.trim() || null,
        })
        toast.success('Dictionary updated.')
        await loadDictionaries(selectedDictionary.dictionary_key)
      } else {
        const response = await createDictionary({
          name,
          dictionary_key: dictionaryForm.dictionary_key.trim() || suggestedCode(name),
          description: dictionaryForm.description.trim() || null,
        })
        toast.success('Dictionary created.')
        await loadDictionaries(response.dictionary.dictionary_key)
      }
      setDictionaryEditor(null)
    }, 'The dictionary action failed.')
  }

  function openCreateItem() {
    const highestOrder = sortedItems.reduce((maximum, item) => Math.max(maximum, item.sort_order), 0)
    setEditingItem(null)
    setItemForm({ ...EMPTY_ITEM_FORM, sort_order: highestOrder + 1 })
    setItemEditor('create')
  }

  function openEditItem(item: CodeDictionaryItem) {
    setEditingItem(item)
    setItemForm({
      label: item.label,
      item_code: item.item_code,
      sort_order: item.sort_order,
    })
    setItemEditor('edit')
  }

  async function submitItem(event: FormEvent) {
    event.preventDefault()
    const label = itemForm.label.trim()
    if (!selectedKey || !label) return
    await runAction(async () => {
      if (itemEditor === 'edit' && editingItem) {
        await updateDictionaryItem(selectedKey, editingItem.id, {
          label,
          sort_order: itemForm.sort_order,
        })
        toast.success('Dictionary value updated.')
      } else {
        await createDictionaryItem(selectedKey, {
          label,
          item_code: itemForm.item_code.trim() || suggestedCode(label),
          sort_order: itemForm.sort_order,
        })
        toast.success('Dictionary value created.')
      }
      setItemEditor(null)
      setEditingItem(null)
      await loadItems()
      await loadDictionaries(selectedKey)
    }, 'The dictionary value action failed.')
  }

  async function toggleDictionary() {
    if (!selectedDictionary) return
    const nextActive = !selectedDictionary.is_active
    await runAction(async () => {
      await updateDictionary(selectedDictionary.dictionary_key, { is_active: nextActive })
      await loadDictionaries(selectedDictionary.dictionary_key)
      toast.success(`${selectedDictionary.name} ${nextActive ? 'enabled' : 'disabled'}.`)
    }, 'The dictionary action failed.')
  }

  async function toggleItem(item: CodeDictionaryItem) {
    const nextActive = !item.is_active
    await runAction(async () => {
      await updateDictionaryItem(selectedKey, item.id, { is_active: nextActive })
      await loadItems()
      await loadDictionaries(selectedKey)
      toast.success(`${item.label} ${nextActive ? 'enabled' : 'disabled'}.`)
    }, 'The dictionary value action failed.')
  }

  async function moveItem(itemId: number, direction: -1 | 1) {
    const currentIndex = sortedItems.findIndex((item) => item.id === itemId)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sortedItems.length) return
    const reordered = [...sortedItems]
    const [moved] = reordered.splice(currentIndex, 1)
    reordered.splice(nextIndex, 0, moved)
    await runAction(async () => {
      const response = await reorderDictionaryItems(selectedKey, reordered.map((item) => item.id))
      setItems(response.items)
      toast.success('Display order updated.')
    }, 'Could not update the display order.')
  }

  return (
    <>
      <section className="management-panel dictionary-panel">
        <div className="management-panel-heading">
          <div>
            <h2>Dictionaries</h2>
            <span>Maintain reusable code lists shared by Portal resources</span>
          </div>
          <div className="management-panel-heading-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction(async () => {
                await loadDictionaries(selectedKey)
                await loadItems()
              }, 'Could not refresh dictionaries.')}
            >
              <RefreshCw size={16} />
              Refresh
            </button>
            <button className="management-primary-button" type="button" disabled={busy} onClick={openCreateDictionary}>
              <Plus size={16} />
              Add dictionary
            </button>
          </div>
        </div>

        <div className="dictionary-context-toolbar">
          <label>
            <span>Dictionary</span>
            <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
              {dictionaries.map((dictionary) => (
                <option key={dictionary.dictionary_key} value={dictionary.dictionary_key}>
                  {dictionary.name}
                </option>
              ))}
            </select>
          </label>
          <div className="dictionary-context-summary">
            <strong>{selectedDictionary?.name ?? 'No dictionary selected'}</strong>
            <span>{selectedDictionary?.description || 'Select or create a dictionary to maintain its values.'}</span>
          </div>
          {selectedDictionary ? (
            <div className="management-row-actions">
              <button type="button" disabled={busy} onClick={openEditDictionary}>
                <Pencil size={14} />
                Edit
              </button>
              <button type="button" disabled={busy} onClick={() => void toggleDictionary()}>
                {selectedDictionary.is_active ? <PowerOff size={14} /> : <Power size={14} />}
                {selectedDictionary.is_active ? 'Disable' : 'Enable'}
              </button>
            </div>
          ) : null}
        </div>

        <div className="dictionary-list-toolbar">
          <label className="dictionary-search">
            <Search size={16} />
            <input
              aria-label="Search dictionary values"
              placeholder="Search label or code"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>
          <select aria-label="Filter dictionary values by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <span className="dictionary-result-count">{visibleItems.length} of {items.length} values</span>
          <button
            className="management-primary-button"
            type="button"
            disabled={busy || !selectedDictionary}
            onClick={openCreateItem}
          >
            <Plus size={16} />
            Add value
          </button>
        </div>

        <div className="dictionary-guidance">
          <BookOpen size={15} />
          Codes are permanent identifiers. Labels, order, and status can change without breaking saved records.
        </div>

        <div className="management-table-wrap dictionary-table-wrap">
          <table className="dictionary-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Label</th>
                <th>Code</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.length ? visibleItems.map((item) => {
                const fullIndex = sortedItems.findIndex((candidate) => candidate.id === item.id)
                return (
                  <tr key={item.id}>
                    <td>
                      <div className="dictionary-order">
                        <span>{item.sort_order}</span>
                        <button
                          type="button"
                          title={`Move ${item.label} up`}
                          aria-label={`Move ${item.label} up`}
                          disabled={busy || fullIndex === 0}
                          onClick={() => void moveItem(item.id, -1)}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          type="button"
                          title={`Move ${item.label} down`}
                          aria-label={`Move ${item.label} down`}
                          disabled={busy || fullIndex === sortedItems.length - 1}
                          onClick={() => void moveItem(item.id, 1)}
                        >
                          <ArrowDown size={14} />
                        </button>
                      </div>
                    </td>
                    <td><strong>{item.label}</strong></td>
                    <td><code>{item.item_code}</code></td>
                    <td>
                      <span className={`dictionary-status ${item.is_active ? 'active' : 'inactive'}`}>
                        {item.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>{formatTimestamp(item.updated_at)}</td>
                    <td>
                      <div className="management-row-actions">
                        <button type="button" disabled={busy} onClick={() => openEditItem(item)}>
                          <Pencil size={14} />
                          Edit
                        </button>
                        <button type="button" disabled={busy} onClick={() => void toggleItem(item)}>
                          {item.is_active ? <PowerOff size={14} /> : <Power size={14} />}
                          {item.is_active ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              }) : (
                <tr>
                  <td className="dictionary-empty" colSpan={6}>
                    {items.length ? 'No values match the current filters.' : 'No values are configured.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {dictionaryEditor ? (
        <div className="management-modal-backdrop" role="presentation">
          <section className="management-modal dictionary-modal" role="dialog" aria-modal="true" aria-label="Dictionary">
            <div className="management-modal-heading">
              <div>
                <span>Code catalog</span>
                <h3>{dictionaryEditor === 'create' ? 'Add dictionary' : 'Edit dictionary'}</h3>
              </div>
              <button type="button" title="Close" onClick={() => setDictionaryEditor(null)}><X size={18} /></button>
            </div>
            <form className="management-form management-modal-form" onSubmit={submitDictionary}>
              <label>
                <span>Name</span>
                <input required maxLength={100} value={dictionaryForm.name} onChange={(event) => setDictionaryForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label>
                <span>Dictionary key</span>
                <input
                  readOnly={dictionaryEditor === 'edit'}
                  maxLength={64}
                  placeholder={suggestedCode(dictionaryForm.name) || 'dictionary_key'}
                  value={dictionaryForm.dictionary_key}
                  onChange={(event) => setDictionaryForm((current) => ({ ...current, dictionary_key: event.target.value }))}
                />
                <small>The key is permanent and is used by resource code.</small>
              </label>
              <label>
                <span>Description</span>
                <textarea maxLength={500} value={dictionaryForm.description} onChange={(event) => setDictionaryForm((current) => ({ ...current, description: event.target.value }))} />
              </label>
              <div className="management-modal-actions">
                <button type="button" onClick={() => setDictionaryEditor(null)}>Cancel</button>
                <button className="management-primary-button" type="submit" disabled={busy}>
                  {dictionaryEditor === 'create' ? 'Add dictionary' : 'Save changes'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {itemEditor ? (
        <div className="management-modal-backdrop" role="presentation">
          <section className="management-modal dictionary-modal" role="dialog" aria-modal="true" aria-label="Dictionary value">
            <div className="management-modal-heading">
              <div>
                <span>{selectedDictionary?.name}</span>
                <h3>{itemEditor === 'create' ? 'Add value' : 'Edit value'}</h3>
              </div>
              <button type="button" title="Close" onClick={() => setItemEditor(null)}><X size={18} /></button>
            </div>
            <form className="management-form management-modal-form" onSubmit={submitItem}>
              <label>
                <span>Display label</span>
                <input required maxLength={120} value={itemForm.label} onChange={(event) => setItemForm((current) => ({ ...current, label: event.target.value }))} />
              </label>
              <label>
                <span>Code</span>
                <input
                  readOnly={itemEditor === 'edit'}
                  maxLength={64}
                  placeholder={suggestedCode(itemForm.label) || 'item_code'}
                  value={itemForm.item_code}
                  onChange={(event) => setItemForm((current) => ({ ...current, item_code: event.target.value }))}
                />
                <small>The code cannot be changed after creation.</small>
              </label>
              <div className="management-modal-actions">
                <button type="button" onClick={() => setItemEditor(null)}>Cancel</button>
                <button className="management-primary-button" type="submit" disabled={busy}>
                  {itemEditor === 'create' ? 'Add value' : 'Save changes'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  )
}
