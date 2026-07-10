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
  resource_type: 'dashboard' | 'map' | 'tab' | 'doc' | 'report' | 'dataset' | 'service' | 'admin' | 'api'
  url: string
  description: string | null
  category: string | null
  icon: string | null
  is_public: boolean
  is_active: boolean
  created_at: string
  updated_at: string
  sort_order?: number
  effective_permission?: {
    permission_level: number
    permission: string
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
  created_by_user_id: number | null
  created_at: string
  updated_at: string
}

export type BulkPermissionRow = {
  resource: PortalResource
  direct_permission_id: number | null
  direct_permission_level: number | null
  direct_permission: string | null
  effective_permission: {
    permission_level: number
    permission: string
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
}

export type CctvReviewDistanceGroupSave = {
  distance_key: string
  distance_feet: number | null
  am_score: number | null
  defect_comment: string | null
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
  permissions: number
}

export const MANAGEMENT_TOKEN_KEY = 'portal_management_token'
export const MANAGEMENT_ROLE_KEY = 'portal_management_role'

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

export function saveManagementToken(token: string, role?: PortalRole) {
  window.localStorage.setItem(MANAGEMENT_TOKEN_KEY, token)
  window.sessionStorage.setItem(MANAGEMENT_TOKEN_KEY, token)
  if (role) window.localStorage.setItem(MANAGEMENT_ROLE_KEY, role)
  if (role) window.sessionStorage.setItem(MANAGEMENT_ROLE_KEY, role)
}

export function clearManagementToken() {
  window.localStorage.removeItem(MANAGEMENT_TOKEN_KEY)
  window.localStorage.removeItem(MANAGEMENT_ROLE_KEY)
  window.sessionStorage.removeItem(MANAGEMENT_TOKEN_KEY)
  window.sessionStorage.removeItem(MANAGEMENT_ROLE_KEY)
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

  const response = await fetch(path, { ...options, headers })
  const text = await response.text()
  let payload: unknown = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'detail' in payload ? payload.detail : payload
    const message = typeof detail === 'string' ? detail : JSON.stringify(detail ?? payload)
    throw new Error(message || `HTTP ${response.status}`)
  }
  return payload as T
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

export function updateMyFeaturedResources(featured: PortalFeaturedResourceIdsByCategory) {
  return requestJson<PortalFeaturedResourcesResponse>('/api/me/featured-resources', {
    method: 'PUT',
    body: JSON.stringify({ featured }),
  })
}

export function fetchAdminSummary() {
  return requestJson<AdminSummary>('/api/admin/summary')
}

export function fetchUsers(search = '') {
  const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
  return requestJson<{ users: PortalUser[] }>(`/api/admin/users${query}`)
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
  payload: { action: 'submit_to_review' | 'return_to_edit' | 'complete'; memo?: string },
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
