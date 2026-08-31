export type PortalRole = 'user' | 'admin' | 'system_admin'

export type PortalUser = {
  id: number
  username: string
  first_name: string
  last_name: string
  display_name: string
  email: string
  employee_id: string
  team_id: number | null
  team_name: string | null
  manager_user_id: number | null
  manager_name: string | null
  is_active: boolean
  is_system_admin: boolean
  is_admin: boolean
  roles: PortalRole[]
  selected_role: PortalRole
  must_change_password: boolean
  last_login_at: string | null
  password_changed_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type PortalTeam = {
  id: number
  name: string
  description: string | null
  parent_team_id: number | null
  manager_user_id: number | null
  manager_name: string | null
  is_active: boolean
  member_count: number
  created_at: string
  updated_at: string
}

export type PortalResource = {
  id: number
  resource_id: string
  resource_slug: string
  resource_key: string
  name: string
  resource_type: 'dashboard' | 'map' | 'tab' | 'doc' | 'report' | 'form' | 'dataset' | 'service' | 'admin' | 'api'
  url: string
  description: string | null
  category: string | null
  icon: string | null
  help_url?: string | null
  is_public: boolean
  is_active: boolean
  is_released: boolean
  released_at: string | null
  released_by_user_id: number | null
  created_at: string
  updated_at: string
  sort_order?: number
  effective_permission?: {
    permission_level: number
    permission: string
    permission_types: string[]
    source: string
  } | null
}

export type PortalFeaturedCategory = 'all' | 'dashboard' | 'map' | 'tab' | 'doc' | 'report' | 'dataset'
export type PortalFeaturedResourcesByCategory = Partial<Record<PortalFeaturedCategory, PortalResource[]>>
export type PortalFeaturedResourceIdsByCategory = Partial<Record<PortalFeaturedCategory, number[]>>
export type PortalFeaturedResourcesResponse = {
  resources: PortalResource[]
  featured?: PortalFeaturedResourcesByCategory
  configured_categories?: PortalFeaturedCategory[]
  default_resources?: PortalResource[]
  default_featured?: PortalFeaturedResourcesByCategory
  default_configured_categories?: PortalFeaturedCategory[]
}

export type PortalTeamFeaturedResourcesResponse = {
  team: PortalTeam
  resources: PortalResource[]
  featured?: PortalFeaturedResourcesByCategory
  configured_categories?: PortalFeaturedCategory[]
}

export type PortalFavorite = {
  category: PortalFeaturedCategory
  resource_id: string
  sort_order: number
  created_at: string | null
  updated_at: string | null
  resource: PortalResource
}

export type PortalFavoritesResponse = {
  ok?: boolean
  loaded?: boolean
  message?: string
  category: PortalFeaturedCategory
  favorites: PortalFavorite[]
  total: number
}

export type ResourcePermission = {
  id: number
  resource_id: string
  resource_name: string | null
  user_id: number | null
  user_name: string | null
  team_id: number | null
  team_name: string | null
  permission_level: number
  permission: string
  permission_types: string[]
  created_by_user_id: number | null
  created_at: string
  updated_at: string
}

export type BulkPermissionRow = {
  resource: PortalResource
  direct_permission_id: number | null
  direct_permission_level: number | null
  direct_permission: string | null
  direct_permission_types: string[]
  effective_permission: {
    permission_level: number
    permission: string
    permission_types: string[]
    source: string
  } | null
}

export type BulkPermissionMatrixResponse = {
  subject_type: 'team' | 'user'
  subject_id: number
  rows: BulkPermissionRow[]
}

export type BulkPermissionAssignment = {
  resource_id: string
  permission_level: number | null
}

export type CctvReviewReportStatus = 'pending' | 'ready_to_review' | 'completed'

export type CctvReviewReport = {
  id: number
  record_revision: string
  report_key: string
  report_name: string
  binding_type: 'address' | 'project_title'
  binding_text: string
  inspection_date_text: string
  status: CctvReviewReportStatus
  created_by_user_id: number | null
  created_by_name: string | null
  created_at: string
  updated_by_user_id: number | null
  updated_by_name: string | null
  updated_at: string
  submitted_by_user_id: number | null
  submitted_by_name: string | null
  submitted_at: string | null
  reviewed_by_user_id: number | null
  reviewed_by_name: string | null
  reviewed_at: string | null
  can_delete?: boolean
}

export type CctvReviewReportEvent = {
  id: number
  report_id: number
  event_type: string
  event_by_user_id: number | null
  event_by_name: string | null
  event_at: string
  from_status: CctvReviewReportStatus | null
  to_status: CctvReviewReportStatus | null
  memo: string | null
}

export type CctvReviewObservationSave = {
  mlo_id: string | null
  source_observation_key: string
  defect_role: 'none' | 'major' | 'other'
  is_extensive: boolean
  selected_picture_file_name: string | null
  selected_picture_media_id?: string | null
  defect_callout: string | null
}

export type CctvReviewDistanceGroupSave = {
  distance_key: string
  distance_feet: number | null
  am_score: number | null
  /** @deprecated legacy group-level callout, kept only to read reports saved before per-observation callouts */
  defect_comment?: string | null
  no_am_score_ge_3_confirmed: boolean
  observations: CctvReviewObservationSave[]
}

export type CctvReviewPipeSave = {
  ml_id: string
  mli_id: string
  clogging_percent: number
  clogging_comment: string | null
  clogging_frame_seconds: number | null
  distance_groups: CctvReviewDistanceGroupSave[]
}

export type CctvReviewReportSavePayload = {
  report_key: string
  report_name: string
  binding_type: CctvReviewReport['binding_type']
  binding_text: string
  inspection_date_text: string
  record_revision?: string | null
  memo?: string | null
  pipes: CctvReviewPipeSave[]
}

export type CctvReviewSavedObservation = CctvReviewObservationSave & {
  id: number
  distance_group_id: number
}

export type CctvReviewSavedDistanceGroup = Omit<CctvReviewDistanceGroupSave, 'observations'> & {
  id: number
  pipe_review_id: number
  observations: CctvReviewSavedObservation[]
}

export type CctvReviewSavedPipe = Omit<CctvReviewPipeSave, 'distance_groups'> & {
  id: number
  report_id: number
  distance_groups: CctvReviewSavedDistanceGroup[]
}

export type CctvReviewReportDetail = {
  report: CctvReviewReport
  pipes: CctvReviewSavedPipe[]
}

export type ResourceDiscoveryStatus = 'new' | 'changed' | 'unchanged' | 'conflict' | 'invalid' | 'stale' | 'inactive_stale'

export type ResourceDiscoveryItem = {
  resource_id: string | null
  resource_slug: string
  resource_key: string
  existing_resource_key?: string
  existing_resource_id: number | null
  name: string
  resource_type: PortalResource['resource_type']
  url: string
  description: string | null
  category: string | null
  icon: string | null
  is_public: boolean
  is_active: boolean
  source: string
  status: ResourceDiscoveryStatus
  changes: Record<string, { current: unknown; detected: unknown }>
}

export type ResourceDiscoveryResponse = {
  resources: ResourceDiscoveryItem[]
  counts: Record<string, number>
}

export type ResourceDiscoveryAction = {
  resource_key: string
  action: 'add' | 'update' | 'disable'
}

export type ResourceDiscoveryApplyResponse = {
  applied: Array<{ resource_key: string; action: string }>
  skipped: Array<{ resource_key: string; action: string; reason: string }>
  discovery: ResourceDiscoveryResponse
}

export type AuditLog = {
  id: number
  actor_user_id: number | null
  action: string
  target_type: string
  target_id: number | null
  details_json: string | null
  created_at: string
}

export type HolidayCalendar = {
  calendar_id: string
  calendar_year: number
  label: string
  notes: string | null
  holiday_count?: number
  created_by_user_id: number
  created_by_name: string
  created_at: string
  updated_by_user_id: number
  updated_by_name: string
  updated_at: string
}

export type HolidayEntry = {
  holiday_id: string
  calendar_id: string
  holiday_name: string
  holiday_date: string
  holiday_hours: number
  day_type: 'full_day' | 'partial_day'
  applies_to_weekly_target: boolean
  extends_deliverable_deadline: boolean
  is_active: boolean
  notes: string | null
  created_by_user_id: number
  created_by_name: string
  created_at: string
  updated_by_user_id: number
  updated_by_name: string
  updated_at: string
}

export type HolidayValidationIssue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  holiday_id: string | null
}

export type HolidayValidationResult = {
  valid: boolean
  issues: HolidayValidationIssue[]
  active_holiday_count: number
}

export type CodeDictionary = {
  id: number
  dictionary_key: string
  name: string
  description: string | null
  is_active: boolean
  item_count: number
  active_item_count: number
  created_at: string
  updated_at: string
}

export type CodeDictionaryItem = {
  id: number
  dictionary_id: number
  item_code: string
  label: string
  sort_order: number
  is_active: boolean
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type HolidayCalendarDetail = {
  calendar: HolidayCalendar
  holidays: HolidayEntry[]
  validation: HolidayValidationResult
}

export type HolidaySavePayload = {
  holiday_name: string
  holiday_date: string
  holiday_hours: number
  day_type: HolidayEntry['day_type']
  applies_to_weekly_target: boolean
  extends_deliverable_deadline: boolean
  is_active: boolean
  notes?: string | null
}

export type LoginResponse = {
  token?: string
  token_type?: string
  user: PortalUser
  roles?: PortalRole[]
  requires_role_selection?: boolean
}

export type AdminSummary = {
  users: number
  teams: number
  resources: number
  released_resources: number
  unreleased_resources: number
  permissions: number
}

export const MANAGEMENT_TOKEN_KEY = 'portal_management_token'
export const MANAGEMENT_ROLE_KEY = 'portal_management_role'
export const MANAGEMENT_USER_KEY = 'portal_management_user'

function storedValue(key: string) {
  return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key) ?? ''
}

export function storedManagementToken() {
  return storedValue(MANAGEMENT_TOKEN_KEY)
}

export function storedManagementRole(): PortalRole | '' {
  const role = storedValue(MANAGEMENT_ROLE_KEY)
  return role === 'user' || role === 'admin' || role === 'system_admin' ? role : ''
}

export function sessionManagementRole(): PortalRole | '' {
  const role = window.sessionStorage.getItem(MANAGEMENT_ROLE_KEY) ?? ''
  return role === 'user' || role === 'admin' || role === 'system_admin' ? role : ''
}

export function storedManagementUser(): PortalUser | null {
  const value = storedValue(MANAGEMENT_USER_KEY)
  if (!value) return null
  try {
    return JSON.parse(value) as PortalUser
  } catch {
    return null
  }
}

export function saveManagementUser(user: PortalUser) {
  const value = JSON.stringify(user)
  window.localStorage.setItem(MANAGEMENT_USER_KEY, value)
  window.sessionStorage.setItem(MANAGEMENT_USER_KEY, value)
}

export function saveManagementToken(token: string, role?: PortalRole) {
  window.localStorage.setItem(MANAGEMENT_TOKEN_KEY, token)
  window.sessionStorage.setItem(MANAGEMENT_TOKEN_KEY, token)
  if (role) window.localStorage.setItem(MANAGEMENT_ROLE_KEY, role)
  if (role) window.sessionStorage.setItem(MANAGEMENT_ROLE_KEY, role)
}

export function clearManagementToken() {
  window.localStorage.removeItem(MANAGEMENT_TOKEN_KEY)
  window.localStorage.removeItem(MANAGEMENT_ROLE_KEY)
  window.localStorage.removeItem(MANAGEMENT_USER_KEY)
  window.sessionStorage.removeItem(MANAGEMENT_TOKEN_KEY)
  window.sessionStorage.removeItem(MANAGEMENT_ROLE_KEY)
  window.sessionStorage.removeItem(MANAGEMENT_USER_KEY)
}

export function managementSessionTransferUrl(path: string, token: string, role: PortalRole) {
  const payload = window.btoa(JSON.stringify({ token, role }))
  return `${path}#portal_session=${encodeURIComponent(payload)}`
}

export function consumeManagementSessionTransfer() {
  const hash = window.location.hash
  if (!hash.startsWith('#portal_session=')) return null

  try {
    const payload = JSON.parse(window.atob(decodeURIComponent(hash.slice('#portal_session='.length)))) as {
      token?: unknown
      role?: unknown
    }
    if (
      typeof payload.token === 'string' &&
      (payload.role === 'user' || payload.role === 'admin' || payload.role === 'system_admin')
    ) {
      saveManagementToken(payload.token, payload.role)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
      return { token: payload.token, role: payload.role }
    }
  } catch {
    // Ignore malformed handoff fragments and fall through to stored session lookup.
  }

  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  return null
}

async function requestJson<T>(path: string, options: RequestInit = {}, token = storedManagementToken()): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  return portalRequestJson<T>(path, { ...options, headers })
}

export function login(loginValue: string, password: string, role?: PortalRole) {
  return requestJson<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: loginValue, password, ...(role ? { role } : {}) }),
  }, '')
}

export function switchRole(role: PortalRole) {
  return requestJson<{ token: string; token_type: string; user: PortalUser }>('/api/auth/switch-role', {
    method: 'POST',
    body: JSON.stringify({ role }),
  })
}

export function changePassword(currentPassword: string, newPassword: string) {
  return requestJson<{ ok: boolean; user: PortalUser }>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  })
}

export function fetchMe(token?: string) {
  return requestJson<{ user: PortalUser }>('/api/me', {}, token)
}

export function fetchMyResources(token?: string) {
  return requestJson<{ resources: PortalResource[] }>('/api/me/resources', {}, token)
}

export function fetchMyFeaturedResources(token?: string) {
  return requestJson<PortalFeaturedResourcesResponse>('/api/me/featured-resources', {}, token)
}

function favoritesCategoryQuery(category: PortalFeaturedCategory) {
  return `?category=${encodeURIComponent(category)}`
}

export function fetchMyFavorites(category: PortalFeaturedCategory, token?: string) {
  return requestJson<PortalFavoritesResponse>(`/api/me/favorites${favoritesCategoryQuery(category)}`, {}, token)
}

export function addMyFavorite(resourceId: string, category: PortalFeaturedCategory, token?: string) {
  return requestJson<PortalFavoritesResponse>(`/api/me/favorites/${encodeURIComponent(resourceId)}${favoritesCategoryQuery(category)}`, {
    method: 'PUT',
  }, token)
}

export function removeMyFavorite(resourceId: string, category: PortalFeaturedCategory, token?: string) {
  return requestJson<PortalFavoritesResponse>(`/api/me/favorites/${encodeURIComponent(resourceId)}${favoritesCategoryQuery(category)}`, {
    method: 'DELETE',
  }, token)
}

export function loadMyTeamFavoriteSettings(category: PortalFeaturedCategory, token?: string) {
  return requestJson<PortalFavoritesResponse>(`/api/me/favorites/load-team-settings${favoritesCategoryQuery(category)}`, {
    method: 'POST',
  }, token)
}

export function fetchAdminSummary() {
  return requestJson<AdminSummary>('/api/admin/summary')
}

export function fetchUsers(search = '') {
  const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
  return requestJson<{ users: PortalUser[] }>(`/api/admin/users${query}`)
}

export function fetchTestAccessUsers() {
  return requestJson<{ users: PortalUser[] }>('/api/test-access/users')
}

export function createUser(payload: {
  first_name: string
  last_name: string
  email: string
  employee_id: string
  team_id: number | null
  is_admin: boolean
}) {
  return requestJson<{ user: PortalUser }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateUser(userId: number, payload: Partial<Pick<PortalUser, 'first_name' | 'last_name' | 'email' | 'employee_id' | 'username' | 'team_id' | 'is_active'>>) {
  return requestJson<{ user: PortalUser }>(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteUser(userId: number) {
  return requestJson<{ ok: boolean; user: PortalUser }>(`/api/admin/users/${userId}`, { method: 'DELETE' })
}

export function resetUserPassword(userId: number) {
  return requestJson<{ ok: boolean; temporary_password: string; user: PortalUser }>(`/api/admin/users/${userId}/reset-password`, {
    method: 'POST',
  })
}

export function setAdminStatus(userId: number, isAdmin: boolean) {
  return requestJson<{ user: PortalUser }>(`/api/admin/users/${userId}/admin-status`, {
    method: 'PATCH',
    body: JSON.stringify({ is_admin: isAdmin }),
  })
}

export function fetchTeams() {
  return requestJson<{ teams: PortalTeam[] }>('/api/admin/teams')
}

export function createTeam(payload: {
  name: string
  description: string
  parent_team_id: number | null
  manager_user_id: number | null
  is_active: boolean
}) {
  return requestJson<{ team: PortalTeam }>('/api/admin/teams', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateTeam(teamId: number, payload: Partial<Pick<PortalTeam, 'name' | 'description' | 'parent_team_id' | 'manager_user_id' | 'is_active'>>) {
  return requestJson<{ team: PortalTeam }>(`/api/admin/teams/${teamId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function fetchTeamFeaturedResources(teamId: number) {
  return requestJson<PortalTeamFeaturedResourcesResponse>(`/api/admin/teams/${teamId}/featured-resources`)
}

export function updateTeamFeaturedResources(teamId: number, featured: PortalFeaturedResourceIdsByCategory) {
  return requestJson<PortalTeamFeaturedResourcesResponse>(`/api/admin/teams/${teamId}/featured-resources`, {
    method: 'PUT',
    body: JSON.stringify({ featured }),
  })
}

export function deleteTeam(teamId: number) {
  return requestJson<{ ok: boolean }>(`/api/admin/teams/${teamId}`, { method: 'DELETE' })
}

export function fetchResources() {
  return requestJson<{ resources: PortalResource[] }>('/api/admin/resources')
}

export function discoverResources() {
  return requestJson<ResourceDiscoveryResponse>('/api/admin/resources/discovery')
}

export function applyResourceDiscovery(actions: ResourceDiscoveryAction[]) {
  return requestJson<ResourceDiscoveryApplyResponse>('/api/admin/resources/discovery/apply', {
    method: 'POST',
    body: JSON.stringify({ actions }),
  })
}

export function createResource(payload: {
  resource_id: string
  resource_key: string
  name: string
  resource_type: PortalResource['resource_type']
  url: string
  description: string
  category: string
  is_public: boolean
  is_active: boolean
}) {
  return requestJson<{ resource: PortalResource }>('/api/admin/resources', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateResource(resourceId: number, payload: Partial<PortalResource>) {
  return requestJson<{ resource: PortalResource }>(`/api/admin/resources/${resourceId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function releaseResource(resourceId: number) {
  return requestJson<{ resource: PortalResource }>(`/api/admin/resources/${resourceId}/release`, {
    method: 'POST',
  })
}

export function withdrawResourceRelease(resourceId: number) {
  return requestJson<{ resource: PortalResource }>(`/api/admin/resources/${resourceId}/withdraw-release`, {
    method: 'POST',
  })
}

export function deleteResource(resourceId: number) {
  return requestJson<{ ok: boolean }>(`/api/admin/resources/${resourceId}`, { method: 'DELETE' })
}

export function fetchResourcePermissions(resourceId: number) {
  return requestJson<{ resource: PortalResource; permissions: ResourcePermission[] }>(`/api/admin/resources/${resourceId}/permissions`)
}

export function replaceResourcePermissions(
  resourceId: number,
  permissions: Array<{ user_id: number | null; team_id: number | null; permission_level: number }>,
) {
  return requestJson<{ resource: PortalResource; permissions: ResourcePermission[] }>(`/api/admin/resources/${resourceId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ permissions }),
  })
}

export function fetchPermissionMatrix(params: {
  subject_type: 'team' | 'user'
  subject_id: number
  search?: string
  resource_type?: string
  category?: string
  include_inactive?: boolean
}) {
  const query = new URLSearchParams({
    subject_type: params.subject_type,
    subject_id: String(params.subject_id),
  })
  if (params.search?.trim()) query.set('search', params.search.trim())
  if (params.resource_type?.trim()) query.set('resource_type', params.resource_type.trim())
  if (params.category?.trim()) query.set('category', params.category.trim())
  if (params.include_inactive) query.set('include_inactive', 'true')
  return requestJson<BulkPermissionMatrixResponse>(`/api/admin/permissions/matrix?${query.toString()}`)
}

export function updatePermissionMatrix(payload: {
  subject_type: 'team' | 'user'
  subject_id: number
  assignments: BulkPermissionAssignment[]
}) {
  return requestJson<{ ok: boolean; created: number; updated: number; deleted: number }>('/api/admin/permissions/matrix', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function fetchCctvReviewReports() {
  return requestJson<{ reports: CctvReviewReport[]; total: number }>('/api/reports/proactive-team-cctv-review/reports')
}

export function pullBusinessDataNow() {
  const user = storedManagementUser()
  if (!user) {
    throw new Error('No signed-in Portal user is available for data synchronization.')
  }

  return requestJson<{ cursors: Record<string, number>; status: Record<string, unknown> }>('/api/sync/pull', {
    method: 'POST',
    body: JSON.stringify({
      user_id: String(user.id),
      employee_number: user.employee_id,
      email: user.email,
    }),
  })
}

export function fetchCctvReviewReportDetail(reportId: number) {
  return requestJson<CctvReviewReportDetail>(`/api/reports/proactive-team-cctv-review/reports/${reportId}`)
}

export function saveCctvReviewReport(payload: CctvReviewReportSavePayload) {
  return requestJson<{ ok: boolean; created: boolean; report: CctvReviewReport }>(
    '/api/reports/proactive-team-cctv-review/reports/save',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function updateCctvReviewReportStatus(
  reportId: number,
  payload: { action: 'submit_to_review' | 'return_to_edit' | 'complete'; record_revision: string; memo?: string },
) {
  return requestJson<{ ok: boolean; report_id: number; from_status: CctvReviewReportStatus; to_status: CctvReviewReportStatus }>(
    `/api/reports/proactive-team-cctv-review/reports/${reportId}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  )
}

export function deleteCctvReviewReport(reportId: number) {
  return requestJson<{
    ok: boolean
    report_id: number
    deleted: {
      observations: number
      distance_groups: number
      pipes: number
      events: number
      reports: number
    }
  }>(`/api/reports/proactive-team-cctv-review/reports/${reportId}`, {
    method: 'DELETE',
  })
}

export function fetchCctvReviewReportEvents(reportId: number) {
  return requestJson<{ events: CctvReviewReportEvent[]; total: number }>(
    `/api/reports/proactive-team-cctv-review/reports/${reportId}/events`,
  )
}

export function fetchAuditLogs() {
  return requestJson<{ logs: AuditLog[] }>('/api/admin/audit-logs?limit=100')
}

export function fetchDictionaries() {
  return requestJson<{ dictionaries: CodeDictionary[] }>('/api/admin/dictionaries')
}

export function createDictionary(payload: {
  name: string
  dictionary_key?: string | null
  description?: string | null
}) {
  return requestJson<{ dictionary: CodeDictionary }>('/api/admin/dictionaries', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateDictionary(
  dictionaryKey: string,
  payload: { name?: string; description?: string | null; is_active?: boolean },
) {
  return requestJson<{ dictionary: CodeDictionary }>(
    `/api/admin/dictionaries/${encodeURIComponent(dictionaryKey)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  )
}

export function fetchDictionaryItems(dictionaryKey: string) {
  return requestJson<{ dictionary: CodeDictionary; items: CodeDictionaryItem[] }>(
    `/api/admin/dictionaries/${encodeURIComponent(dictionaryKey)}/items`,
  )
}

export function createDictionaryItem(
  dictionaryKey: string,
  payload: {
    label: string
    item_code?: string | null
    sort_order?: number | null
    metadata?: Record<string, unknown> | null
  },
) {
  return requestJson<{ item: CodeDictionaryItem }>(
    `/api/admin/dictionaries/${encodeURIComponent(dictionaryKey)}/items`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function updateDictionaryItem(
  dictionaryKey: string,
  itemId: number,
  payload: {
    label?: string
    sort_order?: number
    is_active?: boolean
    metadata?: Record<string, unknown> | null
  },
) {
  return requestJson<{ item: CodeDictionaryItem }>(
    `/api/admin/dictionaries/${encodeURIComponent(dictionaryKey)}/items/${itemId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  )
}

export function reorderDictionaryItems(dictionaryKey: string, itemIds: number[]) {
  return requestJson<{ items: CodeDictionaryItem[] }>(
    `/api/admin/dictionaries/${encodeURIComponent(dictionaryKey)}/items-order`,
    {
    method: 'PUT',
      body: JSON.stringify({ item_ids: itemIds }),
    },
  )
}

export function fetchHolidayCalendars() {
  return requestJson<{ calendars: HolidayCalendar[]; total: number }>('/api/admin/holidays/calendars')
}

export function fetchPublishedHolidayCalendar(year: number) {
  return requestJson<HolidayCalendarDetail>(`/api/holidays/published?year=${encodeURIComponent(year)}`)
}

export function fetchHolidayCalendar(calendarId: string) {
  return requestJson<HolidayCalendarDetail>(`/api/admin/holidays/calendars/${encodeURIComponent(calendarId)}`)
}

export function createHolidayCalendar(payload: {
  calendar_year: number
  label?: string | null
  notes?: string | null
  copy_from_calendar_id?: string | null
}) {
  return requestJson<{ ok: boolean; calendar: HolidayCalendar }>('/api/admin/holidays/calendars', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateHolidayCalendar(calendarId: string, payload: { label?: string | null; notes?: string | null }) {
  return requestJson<{ ok: boolean; calendar: HolidayCalendar }>(
    `/api/admin/holidays/calendars/${encodeURIComponent(calendarId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  )
}

export function createHoliday(calendarId: string, payload: HolidaySavePayload) {
  return requestJson<{ ok: boolean; holiday: HolidayEntry }>(
    `/api/admin/holidays/calendars/${encodeURIComponent(calendarId)}/holidays`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function updateHoliday(calendarId: string, holidayId: string, payload: HolidaySavePayload) {
  return requestJson<{ ok: boolean; holiday: HolidayEntry }>(
    `/api/admin/holidays/calendars/${encodeURIComponent(calendarId)}/holidays/${encodeURIComponent(holidayId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  )
}

export function deleteHoliday(calendarId: string, holidayId: string) {
  return requestJson<{ ok: boolean; holiday_id: string }>(
    `/api/admin/holidays/calendars/${encodeURIComponent(calendarId)}/holidays/${encodeURIComponent(holidayId)}`,
    { method: 'DELETE' },
  )
}

export function deleteHolidayCalendar(calendarId: string) {
  return requestJson<{ ok: boolean; calendar_id: string; deleted_holiday_count: number }>(
    `/api/admin/holidays/calendars/${encodeURIComponent(calendarId)}`,
    { method: 'DELETE' },
  )
}

export function validateHolidayCalendar(calendarId: string) {
  return requestJson<HolidayValidationResult>(
    `/api/admin/holidays/calendars/${encodeURIComponent(calendarId)}/validate`,
    { method: 'POST' },
  )
}
import { portalRequestJson } from '../desktop/request'
