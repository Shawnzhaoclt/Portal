import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowUpDown,
  Building2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Home,
  KeyRound,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  UserCog,
  UserRound,
  Users,
} from 'lucide-react'
import { ADMIN_MANAGEMENT_ROUTE, PORTAL_LOGIN_ROUTE } from '../dashboardCatalog'
import {
  applyResourceDiscovery,
  clearManagementToken,
  consumeManagementSessionTransfer,
  deleteResource,
  deleteTeam,
  createTeam,
  createUser,
  deleteUser,
  discoverResources,
  fetchAdminSummary,
  fetchAuditLogs,
  fetchMe,
  fetchMyFeaturedResources,
  fetchMyResources,
  fetchPermissionMatrix,
  fetchResourcePermissions,
  fetchResources,
  fetchTeamFeaturedResources,
  fetchTeams,
  fetchUsers,
  login,
  replaceResourcePermissions,
  resetUserPassword,
  managementSessionTransferUrl,
  saveManagementToken,
  setAdminStatus,
  storedManagementRole,
  storedManagementToken,
  updateMyFeaturedResources,
  updatePermissionMatrix,
  updateResource,
  updateTeamFeaturedResources,
  updateTeam,
  updateUser,
  type AdminSummary,
  type AuditLog,
  type BulkPermissionAssignment,
  type BulkPermissionRow,
  type PortalRole,
  type PortalFeaturedCategory,
  type PortalFeaturedResourceIdsByCategory,
  type PortalFeaturedResourcesByCategory,
  type PortalResource,
  type PortalTeam,
  type PortalUser,
  type ResourceDiscoveryAction,
  type ResourceDiscoveryItem,
  type ResourcePermission,
} from './api'
import './ManagementPage.css'

type ManagementPageProps = {
  loginOnly?: boolean
}

type TabKey = 'profile' | 'featured' | 'users' | 'teams' | 'resources' | 'permissions' | 'audit'
type FeaturedEditorMode = 'personal' | 'team'
type UserSortKey = 'name' | 'email' | 'employee_id' | 'team' | 'role' | 'status'
type SortDirection = 'asc' | 'desc'
type UserFilters = {
  name: string
  email: string
  employeeId: string
  teamId: string
  role: '' | 'admin' | 'user'
  status: '' | 'active' | 'disabled'
}

const SELF_SERVICE_TABS: TabKey[] = ['profile', 'featured']

function tabFromQuery(): TabKey {
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (
    tab === 'profile' ||
    tab === 'featured' ||
    tab === 'users' ||
    tab === 'teams' ||
    tab === 'resources' ||
    tab === 'permissions' ||
    tab === 'audit'
  ) {
    return tab
  }
  return 'profile'
}

type PermissionDraft = {
  user_id: number | null
  team_id: number | null
  permission_level: number
}

type DiscoverySelection = ResourceDiscoveryAction['action'] | ''

type PendingRoleLogin = {
  loginValue: string
  password: string
  roles: PortalRole[]
  user: PortalUser
}

const EMPTY_USER_FORM = {
  first_name: '',
  last_name: '',
  email: '',
  employee_id: '',
  team_id: '',
  is_admin: false,
}

const EMPTY_TEAM_FORM = {
  name: '',
  description: '',
  parent_team_id: '',
  manager_user_id: '',
  is_active: true,
}

const PERMISSION_OPTIONS = [
  { value: 10, label: 'View' },
  { value: 20, label: 'Edit' },
  { value: 30, label: 'Manage' },
  { value: 40, label: 'Admin' },
]

const RESOURCE_TYPE_OPTIONS: Array<PortalResource['resource_type']> = ['dashboard', 'map', 'tab', 'doc', 'report', 'dataset', 'service', 'admin', 'api']
const FEATURED_LIMIT_PER_CATEGORY = 4
const FEATURED_CATEGORY_OPTIONS: Array<{ key: PortalFeaturedCategory; label: string }> = [
  { key: 'all', label: 'All resources' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'map', label: 'Map' },
  { key: 'tab', label: 'Tab' },
  { key: 'doc', label: 'Doc' },
  { key: 'report', label: 'Report' },
  { key: 'dataset', label: 'Dataset' },
]

function asNullableNumber(value: string) {
  return value ? Number(value) : null
}

function roleText(role: PortalRole) {
  if (role === 'system_admin') return 'System admin'
  if (role === 'admin') return 'Admin'
  return 'User'
}

function roleLabel(user: PortalUser) {
  return roleText(user.selected_role)
}

function grantedRoleLabels(user: PortalUser) {
  return user.roles.map(roleText).join(', ')
}

function userTableRoleLabel(user: PortalUser) {
  return user.is_admin || user.is_system_admin ? 'Admin' : 'User'
}

function userSortValue(user: PortalUser, key: UserSortKey) {
  if (key === 'name') return user.display_name
  if (key === 'email') return user.email
  if (key === 'employee_id') return user.employee_id
  if (key === 'team') return user.team_name ?? ''
  if (key === 'role') return userTableRoleLabel(user)
  return user.is_active ? 'Active' : 'Disabled'
}

function includesFilterText(value: string | null | undefined, filter: string) {
  const term = filter.trim().toLowerCase()
  return !term || (value ?? '').toLowerCase().includes(term)
}

function userMatchesFilters(user: PortalUser, filters: UserFilters) {
  if (!includesFilterText(user.display_name, filters.name)) return false
  if (!includesFilterText(user.email, filters.email)) return false
  if (!includesFilterText(user.employee_id, filters.employeeId)) return false
  if (filters.teamId && String(user.team_id ?? '') !== filters.teamId) return false
  if (filters.role === 'admin' && userTableRoleLabel(user) !== 'Admin') return false
  if (filters.role === 'user' && userTableRoleLabel(user) !== 'User') return false
  if (filters.status === 'active' && !user.is_active) return false
  if (filters.status === 'disabled' && user.is_active) return false
  return true
}

function canUseManagement(user: PortalUser | null) {
  return user?.selected_role === 'admin' || user?.selected_role === 'system_admin'
}

function canUseSystemAdmin(user: PortalUser | null) {
  return user?.selected_role === 'system_admin'
}

function routeAfterLogin(user: PortalUser) {
  return canUseManagement(user) ? ADMIN_MANAGEMENT_ROUTE : '/'
}

function routeForRole(role: PortalRole) {
  return role === 'admin' || role === 'system_admin' ? ADMIN_MANAGEMENT_ROUTE : '/'
}

function userWithStoredRole(user: PortalUser) {
  const storedRole = storedManagementRole()
  if (storedRole && user.roles.includes(storedRole)) {
    return { ...user, selected_role: storedRole }
  }
  return user
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-'
  const trimmed = value.trim()
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  const isoText = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const parsed = new Date(hasTimeZone ? isoText : `${isoText}Z`)
  if (Number.isNaN(parsed.getTime())) return trimmed
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(parsed)
}

function emptyFeaturedResourceMap(): Record<PortalFeaturedCategory, PortalResource[]> {
  return {
    all: [],
    dashboard: [],
    map: [],
    tab: [],
    doc: [],
    report: [],
    dataset: [],
  }
}

function emptyFeaturedIdMap(): Record<PortalFeaturedCategory, number[]> {
  return {
    all: [],
    dashboard: [],
    map: [],
    tab: [],
    doc: [],
    report: [],
    dataset: [],
  }
}

function normalizeFeaturedResources(
  featured: PortalFeaturedResourcesByCategory | undefined,
  fallbackResources: PortalResource[],
) {
  const normalized = emptyFeaturedResourceMap()
  for (const category of FEATURED_CATEGORY_OPTIONS) {
    normalized[category.key] = [...(featured?.[category.key] ?? [])]
  }
  if (!featured) normalized.all = [...fallbackResources]
  return normalized
}

function featuredIdsFromResources(featured: Record<PortalFeaturedCategory, PortalResource[]>) {
  const ids = emptyFeaturedIdMap()
  for (const category of FEATURED_CATEGORY_OPTIONS) {
    ids[category.key] = featured[category.key].map((resource) => resource.id)
  }
  return ids
}

function hasFeaturedSelections(idsByCategory: Record<PortalFeaturedCategory, number[]>) {
  return FEATURED_CATEGORY_OPTIONS.some((category) => (idsByCategory[category.key] ?? []).length > 0)
}

function portalFeaturedCategoryForResource(resource: PortalResource): Exclude<PortalFeaturedCategory, 'all'> {
  if (resource.resource_type === 'admin' || resource.resource_type === 'api' || resource.resource_type === 'service') return 'dashboard'
  return resource.resource_type
}

function resourceBelongsToFeaturedCategory(resource: PortalResource, category: PortalFeaturedCategory) {
  return category === 'all' || portalFeaturedCategoryForResource(resource) === category
}

function isFeatureableResource(resource: PortalResource) {
  return resource.is_active && resource.resource_type !== 'admin' && resource.resource_type !== 'api' && resource.resource_type !== 'service'
}

function orderedSelectedResources(resources: PortalResource[], selectedIds: number[]) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  return selectedIds.map((resourceId) => byId.get(resourceId)).filter((resource): resource is PortalResource => Boolean(resource))
}

function moveId(ids: number[], index: number, direction: -1 | 1) {
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= ids.length) return ids
  const next = [...ids]
  const [item] = next.splice(index, 1)
  next.splice(nextIndex, 0, item)
  return next
}

function featuredPayloadFromIds(idsByCategory: Record<PortalFeaturedCategory, number[]>) {
  return FEATURED_CATEGORY_OPTIONS.reduce((result, category) => {
    result[category.key] = idsByCategory[category.key] ?? []
    return result
  }, {} as PortalFeaturedResourceIdsByCategory)
}

export default function ManagementPage({ loginOnly = false }: ManagementPageProps) {
  const [token, setToken] = useState(() => consumeManagementSessionTransfer()?.token ?? storedManagementToken())
  const [activeTab, setActiveTab] = useState<TabKey>(() => tabFromQuery())
  const [currentUser, setCurrentUser] = useState<PortalUser | null>(null)
  const [myResources, setMyResources] = useState<PortalResource[]>([])
  const [featuredResourcesByCategory, setFeaturedResourcesByCategory] = useState<Record<PortalFeaturedCategory, PortalResource[]>>(() =>
    emptyFeaturedResourceMap(),
  )
  const [featuredIdsByCategory, setFeaturedIdsByCategory] = useState<Record<PortalFeaturedCategory, number[]>>(() => emptyFeaturedIdMap())
  const [teamTemplateFeaturedIdsByCategory, setTeamTemplateFeaturedIdsByCategory] = useState<Record<PortalFeaturedCategory, number[]>>(() =>
    emptyFeaturedIdMap(),
  )
  const [activeFeaturedCategory, setActiveFeaturedCategory] = useState<PortalFeaturedCategory>('all')
  const [featuredEditorMode, setFeaturedEditorMode] = useState<FeaturedEditorMode>('personal')
  const [selectedFeaturedTeamId, setSelectedFeaturedTeamId] = useState('')
  const [teamFeaturedResourcesByCategory, setTeamFeaturedResourcesByCategory] = useState<Record<PortalFeaturedCategory, PortalResource[]>>(() =>
    emptyFeaturedResourceMap(),
  )
  const [teamFeaturedIdsByCategory, setTeamFeaturedIdsByCategory] = useState<Record<PortalFeaturedCategory, number[]>>(() => emptyFeaturedIdMap())
  const [teamFeaturedLoadedTeamId, setTeamFeaturedLoadedTeamId] = useState('')
  const [summary, setSummary] = useState<AdminSummary | null>(null)
  const [users, setUsers] = useState<PortalUser[]>([])
  const [teams, setTeams] = useState<PortalTeam[]>([])
  const [resources, setResources] = useState<PortalResource[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [selectedResourceId, setSelectedResourceId] = useState<number | null>(null)
  const [permissionDrafts, setPermissionDrafts] = useState<PermissionDraft[]>([])
  const [loginValue, setLoginValue] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [pendingRoleLogin, setPendingRoleLogin] = useState<PendingRoleLogin | null>(null)
  const [newUser, setNewUser] = useState(EMPTY_USER_FORM)
  const [newPermissionType, setNewPermissionType] = useState<'team' | 'user'>('team')
  const [newPermissionSubject, setNewPermissionSubject] = useState('')
  const [newPermissionLevel, setNewPermissionLevel] = useState(10)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const canManage = canUseManagement(currentUser)
  const visibleTabs = useMemo(
    () =>
      [
        { key: 'profile' as const, label: 'Profile', icon: UserRound },
        { key: 'featured' as const, label: 'Featured', icon: Star },
        ...(canManage
          ? [
              { key: 'users' as const, label: 'Users', icon: Users },
              { key: 'teams' as const, label: 'Teams', icon: Settings },
              { key: 'resources' as const, label: 'Resources', icon: ExternalLink },
              { key: 'permissions' as const, label: 'Permissions', icon: ShieldCheck },
              { key: 'audit' as const, label: 'Audit', icon: KeyRound },
            ]
          : []),
      ],
    [canManage],
  )

  async function loadSelf() {
    const [me, resourcesResponse, featuredResponse] = await Promise.all([
      fetchMe(),
      fetchMyResources(),
      fetchMyFeaturedResources(),
    ])
    const sessionUser = userWithStoredRole(me.user)
    const nextFeaturedResources = normalizeFeaturedResources(featuredResponse.featured, featuredResponse.resources)
    const nextTeamTemplateResources = normalizeFeaturedResources(featuredResponse.default_featured, featuredResponse.default_resources ?? [])
    setCurrentUser(sessionUser)
    setMyResources(resourcesResponse.resources)
    setFeaturedResourcesByCategory(nextFeaturedResources)
    setFeaturedIdsByCategory(featuredIdsFromResources(nextFeaturedResources))
    setTeamTemplateFeaturedIdsByCategory(featuredIdsFromResources(nextTeamTemplateResources))
    return sessionUser
  }

  async function loadAdminData() {
    const [summaryResponse, usersResponse, teamsResponse, resourcesResponse, auditResponse] = await Promise.all([
      fetchAdminSummary(),
      fetchUsers(),
      fetchTeams(),
      fetchResources(),
      fetchAuditLogs(),
    ])
    setSummary(summaryResponse)
    setUsers(usersResponse.users)
    setTeams(teamsResponse.teams)
    setResources(resourcesResponse.resources)
    setAuditLogs(auditResponse.logs)
    if (!selectedFeaturedTeamId && teamsResponse.teams.length) {
      const preferredTeamId = currentUser?.team_id ?? teamsResponse.teams[0].id
      const preferredTeam = teamsResponse.teams.find((team) => team.id === preferredTeamId) ?? teamsResponse.teams[0]
      setSelectedFeaturedTeamId(String(preferredTeam.id))
    }
    const nextResourceId = selectedResourceId ?? resourcesResponse.resources[0]?.id ?? null
    setSelectedResourceId(nextResourceId)
    if (nextResourceId) await loadPermissions(nextResourceId)
  }

  async function loadTeamFeaturedDefaults(teamId: string) {
    if (!teamId) return
    setError('')
    const response = await fetchTeamFeaturedResources(Number(teamId))
    const nextFeaturedResources = normalizeFeaturedResources(response.featured, response.resources)
    setTeamFeaturedResourcesByCategory(nextFeaturedResources)
    setTeamFeaturedIdsByCategory(featuredIdsFromResources(nextFeaturedResources))
    setTeamFeaturedLoadedTeamId(teamId)
  }

  async function refreshAll(showMessage = false) {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const user = await loadSelf()
      if (canUseManagement(user)) {
        try {
          await loadAdminData()
        } catch (adminError) {
          setError(adminError instanceof Error ? adminError.message : 'Could not load admin data.')
        }
      }
      if (showMessage) setStatus('Refreshed.')
    } catch (refreshError) {
      clearManagementToken()
      setToken('')
      setCurrentUser(null)
      setError(refreshError instanceof Error ? refreshError.message : 'Could not load management data.')
    } finally {
      setLoading(false)
    }
  }

  async function loadPermissions(resourceId: number) {
    const response = await fetchResourcePermissions(resourceId)
    setPermissionDrafts(
      response.permissions.map((permission: ResourcePermission) => ({
        user_id: permission.user_id,
        team_id: permission.team_id,
        permission_level: permission.permission_level,
      })),
    )
  }

  useEffect(() => {
    if (token) void refreshAll()
  }, [token])

  useEffect(() => {
    if (!canManage || featuredEditorMode !== 'team' || !selectedFeaturedTeamId || teamFeaturedLoadedTeamId === selectedFeaturedTeamId) return
    void loadTeamFeaturedDefaults(selectedFeaturedTeamId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Could not load team featured defaults.')
    })
  }, [canManage, featuredEditorMode, selectedFeaturedTeamId, teamFeaturedLoadedTeamId])

  useEffect(() => {
    if (!loginOnly && !token) {
      window.location.replace(PORTAL_LOGIN_ROUTE)
    }
  }, [loginOnly, token])

  useEffect(() => {
    if (loginOnly && token && currentUser) {
      window.location.replace(routeAfterLogin(currentUser))
    }
  }, [currentUser, loginOnly, token])

  useEffect(() => {
    if (visibleTabs.some((tab) => tab.key === activeTab)) return
    selectTab(SELF_SERVICE_TABS[0])
  }, [activeTab, visibleTabs])

  function selectTab(tabKey: TabKey) {
    setActiveTab(tabKey)
    if (!loginOnly) {
      const params = new URLSearchParams(window.location.search)
      params.set('tab', tabKey)
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`)
    }
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault()
    setError('')
    setStatus('')
    setPendingRoleLogin(null)
    try {
      const response = await login(loginValue, loginPassword)
      if (response.requires_role_selection) {
        const roles = response.roles ?? response.user.roles
        setPendingRoleLogin({ loginValue, password: loginPassword, roles, user: response.user })
        setStatus('Select a role to continue.')
        return
      }
      if (!response.token) {
        throw new Error('Login did not return an authorization token.')
      }
      const selectedRole = response.user.selected_role
      saveManagementToken(response.token, selectedRole)
      if (loginOnly) {
        window.location.replace(managementSessionTransferUrl(routeForRole(selectedRole), response.token, selectedRole))
        return
      }
      setToken(response.token)
      setCurrentUser(response.user)
      setLoginPassword('')
      setPendingRoleLogin(null)
      setStatus('Signed in.')
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Sign in failed.')
    }
  }

  async function handleRoleLogin(role: PortalRole) {
    if (!pendingRoleLogin) return
    setError('')
    setStatus('')
    try {
      const response = await login(pendingRoleLogin.loginValue, pendingRoleLogin.password, role)
      if (!response.token) {
        throw new Error('Login did not return an authorization token.')
      }
      saveManagementToken(response.token, role)
      if (loginOnly) {
        window.location.replace(managementSessionTransferUrl(routeForRole(role), response.token, role))
        return
      }
      setToken(response.token)
      const selectedUser = { ...response.user, selected_role: role }
      setCurrentUser(selectedUser)
      setLoginPassword('')
      setPendingRoleLogin(null)
      setStatus(`Signed in as ${roleText(role)}.`)
    } catch (roleError) {
      setError(roleError instanceof Error ? roleError.message : 'Could not select role.')
    }
  }

  function handleSignOut() {
    clearManagementToken()
    setToken('')
    setCurrentUser(null)
    setPendingRoleLogin(null)
    setLoginPassword('')
    setStatus('Signed out.')
  }

  function setFeaturedCategoryIds(category: PortalFeaturedCategory, nextIds: number[]) {
    setFeaturedIdsByCategory((current) => ({ ...current, [category]: nextIds.slice(0, FEATURED_LIMIT_PER_CATEGORY) }))
  }

  function setTeamFeaturedCategoryIds(category: PortalFeaturedCategory, nextIds: number[]) {
    setTeamFeaturedIdsByCategory((current) => ({ ...current, [category]: nextIds.slice(0, FEATURED_LIMIT_PER_CATEGORY) }))
  }

  function addFeaturedResource(category: PortalFeaturedCategory, resourceId: number) {
    setFeaturedIdsByCategory((current) => {
      const currentIds = current[category] ?? []
      if (currentIds.includes(resourceId) || currentIds.length >= FEATURED_LIMIT_PER_CATEGORY) return current
      return { ...current, [category]: [...currentIds, resourceId] }
    })
  }

  function addTeamFeaturedResource(category: PortalFeaturedCategory, resourceId: number) {
    setTeamFeaturedIdsByCategory((current) => {
      const currentIds = current[category] ?? []
      if (currentIds.includes(resourceId) || currentIds.length >= FEATURED_LIMIT_PER_CATEGORY) return current
      return { ...current, [category]: [...currentIds, resourceId] }
    })
  }

  function removeFeaturedResource(category: PortalFeaturedCategory, resourceId: number) {
    setFeaturedIdsByCategory((current) => ({
      ...current,
      [category]: (current[category] ?? []).filter((id) => id !== resourceId),
    }))
  }

  function removeTeamFeaturedResource(category: PortalFeaturedCategory, resourceId: number) {
    setTeamFeaturedIdsByCategory((current) => ({
      ...current,
      [category]: (current[category] ?? []).filter((id) => id !== resourceId),
    }))
  }

  function moveFeaturedResource(category: PortalFeaturedCategory, index: number, direction: -1 | 1) {
    setFeaturedIdsByCategory((current) => ({
      ...current,
      [category]: moveId(current[category] ?? [], index, direction),
    }))
  }

  function moveTeamFeaturedResource(category: PortalFeaturedCategory, index: number, direction: -1 | 1) {
    setTeamFeaturedIdsByCategory((current) => ({
      ...current,
      [category]: moveId(current[category] ?? [], index, direction),
    }))
  }

  async function saveFeaturedResources() {
    setError('')
    if (featuredEditorMode === 'team') {
      if (!selectedFeaturedTeamId) return
      const response = await updateTeamFeaturedResources(Number(selectedFeaturedTeamId), featuredPayloadFromIds(teamFeaturedIdsByCategory))
      const nextFeaturedResources = normalizeFeaturedResources(response.featured, response.resources)
      setTeamFeaturedResourcesByCategory(nextFeaturedResources)
      setTeamFeaturedIdsByCategory(featuredIdsFromResources(nextFeaturedResources))
      setTeamFeaturedLoadedTeamId(selectedFeaturedTeamId)
      setStatus('Team default featured items saved.')
      return
    }

    const response = await updateMyFeaturedResources(featuredPayloadFromIds(featuredIdsByCategory))
    const nextFeaturedResources = normalizeFeaturedResources(response.featured, response.resources)
    const nextTeamTemplateResources = normalizeFeaturedResources(response.default_featured, response.default_resources ?? [])
    setFeaturedResourcesByCategory(nextFeaturedResources)
    setFeaturedIdsByCategory(featuredIdsFromResources(nextFeaturedResources))
    setTeamTemplateFeaturedIdsByCategory(featuredIdsFromResources(nextTeamTemplateResources))
    setStatus('Featured items saved.')
  }

  async function loadFeaturedFromTeamTemplate() {
    setError('')
    setStatus('')
    if (!hasFeaturedSelections(teamTemplateFeaturedIdsByCategory)) {
      setError('No team featured template is available for your team.')
      return
    }
    const confirmed = window.confirm(
      'Loading favorites from the team template will overwrite your current featured item settings. Continue?',
    )
    if (!confirmed) return

    const response = await updateMyFeaturedResources(featuredPayloadFromIds(teamTemplateFeaturedIdsByCategory))
    const nextFeaturedResources = normalizeFeaturedResources(response.featured, response.resources)
    const nextTeamTemplateResources = normalizeFeaturedResources(response.default_featured, response.default_resources ?? [])
    setFeaturedResourcesByCategory(nextFeaturedResources)
    setFeaturedIdsByCategory(featuredIdsFromResources(nextFeaturedResources))
    setTeamTemplateFeaturedIdsByCategory(featuredIdsFromResources(nextTeamTemplateResources))
    setStatus('Featured items loaded from team template.')
  }

  async function handleCreateUser(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await createUser({
        ...newUser,
        team_id: asNullableNumber(newUser.team_id),
      })
      setNewUser(EMPTY_USER_FORM)
      await loadAdminData()
      setStatus('User created. Initial password is the employee ID.')
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create user.')
      throw createError
    }
  }

  async function handleSaveTeam(teamId: number | null, form: typeof EMPTY_TEAM_FORM) {
    setError('')
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      parent_team_id: asNullableNumber(form.parent_team_id),
      manager_user_id: asNullableNumber(form.manager_user_id),
      is_active: form.is_active,
    }
    if (teamId) {
      await updateTeam(teamId, payload)
    } else {
      await createTeam(payload)
    }
    await loadAdminData()
    setStatus(teamId ? 'Team updated.' : 'Team created.')
  }

  async function handleSelectedResourceChange(value: string) {
    const resourceId = Number(value)
    setSelectedResourceId(resourceId)
    await loadPermissions(resourceId)
  }

  function addPermissionDraft() {
    const subjectId = Number(newPermissionSubject)
    if (!subjectId) return
    setPermissionDrafts((current) => [
      ...current,
      {
        user_id: newPermissionType === 'user' ? subjectId : null,
        team_id: newPermissionType === 'team' ? subjectId : null,
        permission_level: newPermissionLevel,
      },
    ])
    setNewPermissionSubject('')
  }

  async function savePermissions() {
    if (!selectedResourceId) return
    setError('')
    const response = await replaceResourcePermissions(selectedResourceId, permissionDrafts)
    setPermissionDrafts(
      response.permissions.map((permission) => ({
        user_id: permission.user_id,
        team_id: permission.team_id,
        permission_level: permission.permission_level,
      })),
    )
    await loadAdminData()
    setStatus('Permissions saved.')
  }

  if (token && !currentUser) {
    return (
      <main className="management-page login-only">
        <section className="management-login-panel">
          <h1>Portal Sign In</h1>
          <p>Loading session...</p>
        </section>
      </main>
    )
  }

  if (!token || !currentUser) {
    if (!loginOnly) {
      return (
        <main className="management-page login-only">
          <section className="management-login-panel">
            <h1>Portal Sign In</h1>
            <p>Redirecting to sign in...</p>
          </section>
        </main>
      )
    }

    return (
      <main className="management-page login-only">
        <section className="management-login-panel">
          <div className="management-login-mark">
            <LogIn size={28} />
          </div>
          <h1>Portal Sign In</h1>
          {pendingRoleLogin ? (
            <div className="management-role-select">
              <span>Signed in as</span>
              <strong>{pendingRoleLogin.user.display_name}</strong>
              <p>Select a role for this session.</p>
              <div className="management-role-buttons">
                {pendingRoleLogin.roles.map((role) => (
                  <button className={role === 'system_admin' ? 'management-primary-button' : ''} key={role} type="button" onClick={() => handleRoleLogin(role)}>
                    {roleText(role)}
                  </button>
                ))}
              </div>
              {error ? <div className="management-error">{error}</div> : null}
              <button type="button" onClick={() => setPendingRoleLogin(null)}>Use another account</button>
            </div>
          ) : (
            <form onSubmit={handleLogin} className="management-form">
              <div className="management-login-tip">
                Tip: username is your work email address, and the default password is your employee ID.
              </div>
              <label>
                <span>Username, email, or employee ID</span>
                <input value={loginValue} onChange={(event) => setLoginValue(event.target.value)} autoComplete="username" />
              </label>
              <label>
                <span>Password</span>
                <input value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} type="password" autoComplete="current-password" />
              </label>
              {error ? <div className="management-error">{error}</div> : null}
              <button className="management-primary-button" type="submit">
                <LogIn size={17} />
                Sign in
              </button>
            </form>
          )}
        </section>
      </main>
    )
  }

  return (
    <main className="management-page">
      <header className="management-header">
        <div>
          <span>{canManage ? 'Portal Administration' : 'Portal Account'}</span>
          <h1>{canManage ? 'Management' : 'Profile'}</h1>
        </div>
        <div className="management-header-actions">
          <a className="management-header-link" href="/">
            <Home size={16} />
            Back to portal
          </a>
          <button type="button" onClick={() => refreshAll(true)}>
            <RefreshCw size={16} />
            Refresh
          </button>
          <button type="button" onClick={handleSignOut}>Sign out</button>
        </div>
      </header>

      <section className="management-shell">
        <aside className="management-sidebar">
          <div className="management-user-tile">
            <strong>{currentUser.display_name}</strong>
            <span>{roleLabel(currentUser)}</span>
            <span>{currentUser.team_name ?? 'No team'}</span>
          </div>
          <nav>
            {visibleTabs.map((tab) => {
              const Icon = tab.icon
              return (
                <button className={activeTab === tab.key ? 'active' : ''} key={tab.key} type="button" onClick={() => selectTab(tab.key)}>
                  <Icon size={16} />
                  {tab.label}
                </button>
              )
            })}
          </nav>
        </aside>

        <section className="management-content">
          {status ? <div className="management-status">{status}</div> : null}
          {error ? <div className="management-error">{error}</div> : null}
          {loading ? <div className="management-status">Loading...</div> : null}

          {activeTab === 'profile' ? (
            <ProfilePanel
              user={currentUser}
            />
          ) : null}

          {activeTab === 'featured' ? (
            <FeaturedPanel
              activeCategory={activeFeaturedCategory}
              canManage={canManage}
              editorMode={featuredEditorMode}
              featuredIdsByCategory={featuredEditorMode === 'team' ? teamFeaturedIdsByCategory : featuredIdsByCategory}
              featuredResourcesByCategory={featuredEditorMode === 'team' ? teamFeaturedResourcesByCategory : featuredResourcesByCategory}
              hasTeamTemplate={hasFeaturedSelections(teamTemplateFeaturedIdsByCategory)}
              resources={(featuredEditorMode === 'team' ? resources : myResources).filter(isFeatureableResource)}
              selectedTeamId={selectedFeaturedTeamId}
              teams={teams}
              onAdd={featuredEditorMode === 'team' ? addTeamFeaturedResource : addFeaturedResource}
              onCategoryChange={setActiveFeaturedCategory}
              onClearCategory={(category) => (featuredEditorMode === 'team' ? setTeamFeaturedCategoryIds(category, []) : setFeaturedCategoryIds(category, []))}
              onModeChange={setFeaturedEditorMode}
              onLoadTeamTemplate={loadFeaturedFromTeamTemplate}
              onMove={featuredEditorMode === 'team' ? moveTeamFeaturedResource : moveFeaturedResource}
              onRemove={featuredEditorMode === 'team' ? removeTeamFeaturedResource : removeFeaturedResource}
              onSave={saveFeaturedResources}
              onTeamChange={(teamId) => {
                setSelectedFeaturedTeamId(teamId)
                setTeamFeaturedLoadedTeamId('')
              }}
            />
          ) : null}

          {canManage && activeTab === 'users' ? (
            <UsersPanel
              currentUser={currentUser}
              form={newUser}
              teams={teams}
              users={users}
              onAdminStatus={async (userId, isAdmin) => {
                await setAdminStatus(userId, isAdmin)
                await loadAdminData()
              }}
              onCreate={handleCreateUser}
              onDelete={async (userId) => {
                await deleteUser(userId)
                await loadAdminData()
              }}
              onFormChange={setNewUser}
              onResetPassword={async (userId) => {
                await resetUserPassword(userId)
                setStatus('Password reset. Temporary password is the employee ID.')
                await loadAdminData()
              }}
              onUserActiveChange={async (userId, isActive) => {
                await updateUser(userId, { is_active: isActive })
                await loadAdminData()
              }}
              onUserTeamChange={async (userId, teamId) => {
                setError('')
                try {
                  await updateUser(userId, { team_id: teamId })
                  await loadAdminData()
                  setStatus('User team updated.')
                } catch (updateError) {
                  setError(updateError instanceof Error ? updateError.message : 'Could not update user team.')
                  throw updateError
                }
              }}
            />
          ) : null}

          {canManage && activeTab === 'teams' ? (
            <TeamsPanel
              currentUser={currentUser}
              teams={teams}
              users={users}
              onDelete={async (teamId) => {
                await deleteTeam(teamId)
                await loadAdminData()
              }}
              onSave={handleSaveTeam}
              onTeamActiveChange={async (teamId, isActive) => {
                await updateTeam(teamId, { is_active: isActive })
                await loadAdminData()
              }}
            />
          ) : null}

          {canManage && activeTab === 'resources' ? (
            <ResourcesPanel
              currentUser={currentUser}
              resources={resources}
              summary={summary}
              onDelete={async (resourceId) => {
                await deleteResource(resourceId)
                await loadAdminData()
              }}
              onRefresh={loadAdminData}
              onResourceFlagChange={async (resourceId, payload) => {
                await updateResource(resourceId, payload)
                await loadAdminData()
              }}
            />
          ) : null}

          {canManage && activeTab === 'permissions' ? (
            <PermissionsPanel
              newPermissionLevel={newPermissionLevel}
              newPermissionSubject={newPermissionSubject}
              newPermissionType={newPermissionType}
              permissions={permissionDrafts}
              resources={resources}
              selectedResourceId={selectedResourceId}
              currentUser={currentUser}
              teams={teams}
              users={users}
              onAdd={addPermissionDraft}
              onLevelChange={setNewPermissionLevel}
              onPermissionChange={setPermissionDrafts}
              onRemove={(index) => setPermissionDrafts((current) => current.filter((_, draftIndex) => draftIndex !== index))}
              onResourceChange={handleSelectedResourceChange}
              onSave={savePermissions}
              onSubjectChange={setNewPermissionSubject}
              onTypeChange={setNewPermissionType}
            />
          ) : null}

          {canManage && activeTab === 'audit' ? <AuditPanel logs={auditLogs} /> : null}
        </section>
      </section>
    </main>
  )
}

function ProfilePanel({ user }: {
  user: PortalUser
}) {
  return (
    <section className="management-panel">
      <div className="management-panel-heading">
        <h2>Profile</h2>
        {user.must_change_password ? <span className="management-warning">Password change required</span> : null}
      </div>
      <div className="management-detail-grid">
        <Detail label="Name" value={user.display_name} />
        <Detail label="Email" value={user.email} />
        <Detail label="Employee ID" value={user.employee_id} />
        <Detail label="Team" value={user.team_name ?? '-'} />
        <Detail label="Manager" value={user.manager_name ?? '-'} />
        <Detail label="Role" value={roleLabel(user)} />
        <Detail label="Granted Roles" value={grantedRoleLabels(user)} />
      </div>
    </section>
  )
}

function FeaturedPanel({
  activeCategory,
  canManage,
  editorMode,
  featuredIdsByCategory,
  featuredResourcesByCategory,
  hasTeamTemplate,
  resources,
  selectedTeamId,
  teams,
  onAdd,
  onCategoryChange,
  onClearCategory,
  onLoadTeamTemplate,
  onModeChange,
  onMove,
  onRemove,
  onSave,
  onTeamChange,
}: {
  activeCategory: PortalFeaturedCategory
  canManage: boolean
  editorMode: FeaturedEditorMode
  featuredIdsByCategory: Record<PortalFeaturedCategory, number[]>
  featuredResourcesByCategory: Record<PortalFeaturedCategory, PortalResource[]>
  hasTeamTemplate: boolean
  resources: PortalResource[]
  selectedTeamId: string
  teams: PortalTeam[]
  onAdd: (category: PortalFeaturedCategory, resourceId: number) => void
  onCategoryChange: (category: PortalFeaturedCategory) => void
  onClearCategory: (category: PortalFeaturedCategory) => void
  onLoadTeamTemplate: () => void
  onModeChange: (mode: FeaturedEditorMode) => void
  onMove: (category: PortalFeaturedCategory, index: number, direction: -1 | 1) => void
  onRemove: (category: PortalFeaturedCategory, resourceId: number) => void
  onSave: () => void
  onTeamChange: (teamId: string) => void
}) {
  const selectedIds = featuredIdsByCategory[activeCategory] ?? []
  const selectedResources = orderedSelectedResources(
    [...resources, ...(featuredResourcesByCategory[activeCategory] ?? [])],
    selectedIds,
  )
  const availableResources = resources.filter(
    (resource) => resourceBelongsToFeaturedCategory(resource, activeCategory) && !selectedIds.includes(resource.id),
  )
  const limitReached = selectedIds.length >= FEATURED_LIMIT_PER_CATEGORY

  return (
    <section className="management-panel">
      <div className="management-panel-heading">
        <h2>{editorMode === 'team' ? 'Team Default Featured Items' : 'Featured Items'}</h2>
        <div className="management-panel-heading-actions">
          {editorMode === 'personal' ? (
            <button
              className="management-warning-action"
              type="button"
              onClick={onLoadTeamTemplate}
              disabled={!hasTeamTemplate}
              title={
                hasTeamTemplate
                  ? 'Load your team default featured template and overwrite your current settings.'
                  : 'No team featured template is available for your team.'
              }
            >
              <AlertTriangle size={16} />
              Load from team template
            </button>
          ) : null}
          <button className="management-primary-button" type="button" onClick={onSave} disabled={editorMode === 'team' && !selectedTeamId}>
            <Save size={16} />
            {editorMode === 'team' ? 'Save team defaults' : 'Save featured'}
          </button>
        </div>
      </div>
      {canManage ? (
        <div className="management-featured-admin-row">
          <div className="management-segmented" aria-label="Featured editor mode">
            <button className={editorMode === 'personal' ? 'active' : ''} type="button" onClick={() => onModeChange('personal')}>
              My featured
            </button>
            <button className={editorMode === 'team' ? 'active' : ''} type="button" onClick={() => onModeChange('team')}>
              Team defaults
            </button>
          </div>
          {editorMode === 'team' ? (
            <label>
              <span>Team</span>
              <select value={selectedTeamId} onChange={(event) => onTeamChange(event.target.value)}>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="management-featured-toolbar">
        <div className="management-segmented" aria-label="Featured item category">
          {FEATURED_CATEGORY_OPTIONS.map((category) => (
            <button
              className={activeCategory === category.key ? 'active' : ''}
              key={category.key}
              type="button"
              onClick={() => onCategoryChange(category.key)}
            >
              {category.label}
            </button>
          ))}
        </div>
        <span>{selectedIds.length} of {FEATURED_LIMIT_PER_CATEGORY} selected</span>
      </div>
      <div className="management-featured-config">
        <section>
          <div className="management-subheading-row">
            <h3>Featured order</h3>
            <button type="button" onClick={() => onClearCategory(activeCategory)} disabled={!selectedIds.length}>
              Clear category
            </button>
          </div>
          <div className="management-featured-order-list">
            {selectedResources.length ? selectedResources.map((resource, index) => (
              <div className="management-featured-order-row" key={resource.id}>
                <span>{index + 1}</span>
                <ResourcePill resource={resource} />
                <div className="management-row-actions">
                  <button type="button" onClick={() => onMove(activeCategory, index, -1)} disabled={index === 0}>Up</button>
                  <button type="button" onClick={() => onMove(activeCategory, index, 1)} disabled={index === selectedResources.length - 1}>Down</button>
                  <button type="button" onClick={() => onRemove(activeCategory, resource.id)}>Remove</button>
                </div>
              </div>
            )) : (
              <div className="management-empty-note">
                {editorMode === 'team'
                  ? 'No team defaults for this category. The portal will use the built-in default list.'
                  : 'No personal featured items for this category. The portal will show your team default list.'}
              </div>
            )}
          </div>
        </section>
        <section>
          <div className="management-subheading-row">
            <h3>Available resources</h3>
            {limitReached ? <span>Remove an item before adding another.</span> : null}
          </div>
          <div className="management-list compact">
            {availableResources.length ? availableResources.map((resource) => (
              <div className="management-check-row featured-resource-row" key={resource.id}>
                <span>{resource.name}</span>
                <small>{resource.resource_type} - {resource.effective_permission?.source ?? 'access'}</small>
                <button type="button" onClick={() => onAdd(activeCategory, resource.id)} disabled={limitReached}>
                  <Plus size={15} />
                  Add
                </button>
              </div>
            )) : (
              <div className="management-empty-note">No more resources are available for this category.</div>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

function UserSortHeader({
  label,
  sortKey,
  activeSortKey,
  direction,
  onSort,
}: {
  label: string
  sortKey: UserSortKey
  activeSortKey: UserSortKey
  direction: SortDirection
  onSort: (sortKey: UserSortKey) => void
}) {
  const active = sortKey === activeSortKey
  return (
    <button className={active ? 'active' : ''} type="button" onClick={() => onSort(sortKey)}>
      {label}
      <ArrowUpDown size={13} />
      {active ? <span>{direction === 'asc' ? 'Asc' : 'Desc'}</span> : null}
    </button>
  )
}

function UsersPanel({
  currentUser,
  form,
  teams,
  users,
  onAdminStatus,
  onCreate,
  onDelete,
  onFormChange,
  onResetPassword,
  onUserActiveChange,
  onUserTeamChange,
}: {
  currentUser: PortalUser
  form: typeof EMPTY_USER_FORM
  teams: PortalTeam[]
  users: PortalUser[]
  onAdminStatus: (userId: number, isAdmin: boolean) => Promise<void>
  onCreate: (event: FormEvent) => Promise<void>
  onDelete: (userId: number) => Promise<void>
  onFormChange: (form: typeof EMPTY_USER_FORM) => void
  onResetPassword: (userId: number) => Promise<void>
  onUserActiveChange: (userId: number, isActive: boolean) => Promise<void>
  onUserTeamChange: (userId: number, teamId: number | null) => Promise<void>
}) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingTeamUser, setEditingTeamUser] = useState<PortalUser | null>(null)
  const [teamEditValue, setTeamEditValue] = useState('')
  const [userFilters, setUserFilters] = useState<UserFilters>({
    name: '',
    email: '',
    employeeId: '',
    teamId: '',
    role: '',
    status: '',
  })
  const [sortKey, setSortKey] = useState<UserSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const filteredUsers = useMemo(() => users.filter((user) => userMatchesFilters(user, userFilters)), [userFilters, users])
  const orderedUsers = useMemo(() => {
    const directionFactor = sortDirection === 'asc' ? 1 : -1
    return [...filteredUsers].sort((left, right) => {
      const leftValue = userSortValue(left, sortKey)
      const rightValue = userSortValue(right, sortKey)
      const comparison = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: 'base' })
      return comparison * directionFactor
    })
  }, [filteredUsers, sortDirection, sortKey])
  const pageCount = Math.max(1, Math.ceil(orderedUsers.length / pageSize))
  const currentPageIndex = Math.min(pageIndex, pageCount - 1)
  const pageUsers = orderedUsers.slice(currentPageIndex * pageSize, currentPageIndex * pageSize + pageSize)
  const duplicateEmployeeUser = useMemo(() => {
    const employeeId = form.employee_id.trim()
    if (!employeeId) return null
    return users.find((user) => user.employee_id.trim().toLowerCase() === employeeId.toLowerCase()) ?? null
  }, [form.employee_id, users])

  useEffect(() => {
    setPageIndex(0)
  }, [userFilters, pageSize])

  useEffect(() => {
    if (pageIndex >= pageCount) setPageIndex(pageCount - 1)
  }, [pageCount, pageIndex])

  function openCreateDialog() {
    onFormChange(EMPTY_USER_FORM)
    setCreateDialogOpen(true)
  }

  function closeCreateDialog() {
    setCreateDialogOpen(false)
    onFormChange(EMPTY_USER_FORM)
  }

  function openTeamDialog(user: PortalUser) {
    setEditingTeamUser(user)
    setTeamEditValue(user.team_id ? String(user.team_id) : '')
  }

  function closeTeamDialog() {
    setEditingTeamUser(null)
    setTeamEditValue('')
  }

  function handleSort(nextSortKey: UserSortKey) {
    if (nextSortKey === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(nextSortKey)
      setSortDirection('asc')
    }
    setPageIndex(0)
  }

  async function handleCreateSubmit(event: FormEvent) {
    event.preventDefault()
    if (duplicateEmployeeUser) return
    try {
      await onCreate(event)
      closeCreateDialog()
    } catch {
      // Parent handler surfaces the API error in the page status area.
    }
  }

  async function handleTeamSubmit(event: FormEvent) {
    event.preventDefault()
    if (!editingTeamUser) return
    try {
      await onUserTeamChange(editingTeamUser.id, asNullableNumber(teamEditValue))
      closeTeamDialog()
    } catch {
      // Parent handler surfaces the API error in the page status area.
    }
  }

  return (
    <section className="management-panel">
      <div className="management-panel-heading">
        <h2>Users</h2>
        <div className="management-panel-heading-actions">
          <span>{filteredUsers.length} shown, {users.length} accounts</span>
          <button className="management-primary-button" type="button" onClick={openCreateDialog}>
            <Plus size={16} />
            Add user
          </button>
        </div>
      </div>
      <div className="management-table-toolbar user-filters">
        <label className="management-search-control">
          <span>Name</span>
          <Search size={16} />
          <input
            value={userFilters.name}
            onChange={(event) => setUserFilters((current) => ({ ...current, name: event.target.value }))}
            placeholder="Name"
          />
        </label>
        <label>
          <span>Email</span>
          <input
            value={userFilters.email}
            onChange={(event) => setUserFilters((current) => ({ ...current, email: event.target.value }))}
            placeholder="Email"
          />
        </label>
        <label>
          <span>Employee ID</span>
          <input
            value={userFilters.employeeId}
            onChange={(event) => setUserFilters((current) => ({ ...current, employeeId: event.target.value }))}
            placeholder="Employee ID"
          />
        </label>
        <label>
          <span>Team</span>
          <select value={userFilters.teamId} onChange={(event) => setUserFilters((current) => ({ ...current, teamId: event.target.value }))}>
            <option value="">All teams</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
        <label>
          <span>Role</span>
          <select
            value={userFilters.role}
            onChange={(event) => setUserFilters((current) => ({ ...current, role: event.target.value as UserFilters['role'] }))}
          >
            <option value="">All roles</option>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label>
          <span>Status</span>
          <select
            value={userFilters.status}
            onChange={(event) => setUserFilters((current) => ({ ...current, status: event.target.value as UserFilters['status'] }))}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label>
          <span>Rows</span>
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            {[10, 20, 50].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <div className="management-table-wrap">
        <table>
          <thead>
            <tr>
              <th><UserSortHeader label="Name" sortKey="name" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
              <th><UserSortHeader label="Email" sortKey="email" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
              <th><UserSortHeader label="Employee ID" sortKey="employee_id" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
              <th><UserSortHeader label="Team" sortKey="team" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
              <th><UserSortHeader label="Role" sortKey="role" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
              <th><UserSortHeader label="Status" sortKey="status" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageUsers.length ? pageUsers.map((user) => (
              <tr key={user.id}>
                <td>{user.display_name}</td>
                <td>{user.email}</td>
                <td>{user.employee_id}</td>
                <td>{user.team_name ?? '-'}</td>
                <td>{userTableRoleLabel(user)}</td>
                <td>{user.is_active ? 'Active' : 'Disabled'}</td>
                <td>
                  <div className="management-row-actions">
                    {!user.is_admin && !user.is_system_admin ? (
                      <button type="button" onClick={() => onUserActiveChange(user.id, !user.is_active)}>
                        {user.is_active ? 'Disable' : 'Enable'}
                      </button>
                    ) : null}
                    <button type="button" onClick={() => openTeamDialog(user)} disabled={user.is_system_admin && !canUseSystemAdmin(currentUser)}>
                      Edit team
                    </button>
                    <button type="button" onClick={() => onResetPassword(user.id)}>Reset</button>
                    {canUseSystemAdmin(currentUser) && !user.is_system_admin ? (
                      <button type="button" onClick={() => onAdminStatus(user.id, !user.is_admin)}>
                        {user.is_admin ? 'Remove admin' : 'Make admin'}
                      </button>
                    ) : null}
                    {canUseSystemAdmin(currentUser) && !user.is_admin && !user.is_system_admin ? (
                      <button disabled={user.id === currentUser.id} type="button" onClick={() => onDelete(user.id)}>
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan={7}>No users match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="management-pagination">
        <span>
          Page {currentPageIndex + 1} of {pageCount}
        </span>
        <div>
          <button type="button" onClick={() => setPageIndex(0)} disabled={currentPageIndex === 0}>First</button>
          <button type="button" onClick={() => setPageIndex((current) => Math.max(0, current - 1))} disabled={currentPageIndex === 0}>Previous</button>
          <button type="button" onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))} disabled={currentPageIndex >= pageCount - 1}>Next</button>
          <button type="button" onClick={() => setPageIndex(pageCount - 1)} disabled={currentPageIndex >= pageCount - 1}>Last</button>
        </div>
      </div>

      {createDialogOpen ? (
        <div className="management-modal-backdrop">
          <section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title">
            <div className="management-modal-heading">
              <div>
                <span>User</span>
                <h3 id="user-dialog-title">Add User</h3>
              </div>
              <button type="button" onClick={closeCreateDialog}>Cancel</button>
            </div>
            <form className="management-form management-modal-form" onSubmit={handleCreateSubmit}>
              <label>
                <span>First name</span>
                <input value={form.first_name} onChange={(event) => onFormChange({ ...form, first_name: event.target.value })} required />
              </label>
              <label>
                <span>Last name</span>
                <input value={form.last_name} onChange={(event) => onFormChange({ ...form, last_name: event.target.value })} required />
              </label>
              <label>
                <span>Email</span>
                <input value={form.email} onChange={(event) => onFormChange({ ...form, email: event.target.value })} required type="email" />
              </label>
              <label>
                <span>Employee ID</span>
                <input value={form.employee_id} onChange={(event) => onFormChange({ ...form, employee_id: event.target.value })} required />
              </label>
              {duplicateEmployeeUser ? (
                <div className="management-error">Employee ID already exists for {duplicateEmployeeUser.display_name}.</div>
              ) : null}
              <label>
                <span>Team</span>
                <select value={form.team_id} onChange={(event) => onFormChange({ ...form, team_id: event.target.value })}>
                  <option value="">Team</option>
                  {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              </label>
              <label className="management-inline-check">
                <input checked={form.is_admin} disabled={!canUseSystemAdmin(currentUser)} onChange={(event) => onFormChange({ ...form, is_admin: event.target.checked })} type="checkbox" />
                Admin
              </label>
              <div className="management-modal-actions">
                <button type="button" onClick={closeCreateDialog}>Cancel</button>
                <button className="management-primary-button" type="submit" disabled={Boolean(duplicateEmployeeUser)}>
                  <Plus size={16} />
                  Create user
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {editingTeamUser ? (
        <div className="management-modal-backdrop">
          <section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="user-team-dialog-title">
            <div className="management-modal-heading">
              <div>
                <span>User team</span>
                <h3 id="user-team-dialog-title">Edit Team</h3>
              </div>
              <button type="button" onClick={closeTeamDialog}>Cancel</button>
            </div>
            <form className="management-form management-modal-form" onSubmit={handleTeamSubmit}>
              <div className="management-detail">
                <span>User</span>
                <strong>{editingTeamUser.display_name}</strong>
                <small>{editingTeamUser.email}</small>
              </div>
              <label>
                <span>Team</span>
                <select value={teamEditValue} onChange={(event) => setTeamEditValue(event.target.value)}>
                  <option value="">No team</option>
                  {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              </label>
              <div className="management-modal-actions">
                <button type="button" onClick={closeTeamDialog}>Cancel</button>
                <button className="management-primary-button" type="submit">
                  <Save size={16} />
                  Save team
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  )
}

function TeamsPanel({
  currentUser,
  teams,
  users,
  onDelete,
  onSave,
  onTeamActiveChange,
}: {
  currentUser: PortalUser
  teams: PortalTeam[]
  users: PortalUser[]
  onDelete: (teamId: number) => Promise<void>
  onSave: (teamId: number | null, form: typeof EMPTY_TEAM_FORM) => Promise<void>
  onTeamActiveChange: (teamId: number, isActive: boolean) => Promise<void>
}) {
  const [collapsedTeamIds, setCollapsedTeamIds] = useState<Set<number>>(() => new Set())
  const [teamDialogOpen, setTeamDialogOpen] = useState(false)
  const [editingTeam, setEditingTeam] = useState<PortalTeam | null>(null)
  const [teamForm, setTeamForm] = useState(EMPTY_TEAM_FORM)
  const teamTree = useMemo(() => {
    const teamIds = new Set(teams.map((team) => team.id))
    const childTeams = new Map<number | null, PortalTeam[]>()
    for (const team of teams) {
      const parentId = team.parent_team_id && teamIds.has(team.parent_team_id) ? team.parent_team_id : null
      const children = childTeams.get(parentId) ?? []
      children.push(team)
      childTeams.set(parentId, children)
    }
    for (const children of childTeams.values()) {
      children.sort((left, right) => left.name.localeCompare(right.name))
    }
    return {
      roots: childTeams.get(null) ?? [],
      childTeams,
    }
  }, [teams])
  const blockedParentTeamIds = useMemo(() => {
    const blocked = new Set<number>()
    if (!editingTeam) return blocked
    const stack = [editingTeam.id]
    while (stack.length) {
      const teamId = stack.pop()
      if (!teamId || blocked.has(teamId)) continue
      blocked.add(teamId)
      const children = teamTree.childTeams.get(teamId) ?? []
      for (const child of children) stack.push(child.id)
    }
    return blocked
  }, [editingTeam, teamTree.childTeams])
  const parentTeamOptions = teams.filter((team) => !blockedParentTeamIds.has(team.id))

  function openCreateTeamDialog() {
    setEditingTeam(null)
    setTeamForm(EMPTY_TEAM_FORM)
    setTeamDialogOpen(true)
  }

  function openEditTeamDialog(team: PortalTeam) {
    setEditingTeam(team)
    setTeamForm({
      name: team.name,
      description: team.description ?? '',
      parent_team_id: team.parent_team_id ? String(team.parent_team_id) : '',
      manager_user_id: team.manager_user_id ? String(team.manager_user_id) : '',
      is_active: team.is_active,
    })
    setTeamDialogOpen(true)
  }

  function closeTeamDialog() {
    setTeamDialogOpen(false)
    setEditingTeam(null)
    setTeamForm(EMPTY_TEAM_FORM)
  }

  async function handleTeamFormSubmit(event: FormEvent) {
    event.preventDefault()
    await onSave(editingTeam?.id ?? null, teamForm)
    closeTeamDialog()
  }

  function toggleTeam(teamId: number) {
    setCollapsedTeamIds((current) => {
      const next = new Set(current)
      if (next.has(teamId)) {
        next.delete(teamId)
      } else {
        next.add(teamId)
      }
      return next
    })
  }

  return (
    <section className="management-panel">
      <div className="management-panel-heading">
        <h2>Teams</h2>
        <div className="management-panel-heading-actions">
          <span>{teams.length} teams</span>
          <button className="management-primary-button" type="button" onClick={openCreateTeamDialog}>
            <Plus size={16} />
            Add team
          </button>
        </div>
      </div>
      <div className="management-team-tree">
        <div className="management-team-tree-header">
          <strong>Organization Structure</strong>
          <span>{teams.length} teams</span>
        </div>
        {teamTree.roots.length ? (
          <div className="management-team-tree-table" role="treegrid" aria-label="Organization structure">
            <div className="management-team-tree-columns" role="row">
              <span role="columnheader">Team hierarchy</span>
              <span role="columnheader">Manager</span>
              <span role="columnheader">Members</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Actions</span>
            </div>
            {teamTree.roots.map((team) => (
              <TeamTreeRows
                childTeams={teamTree.childTeams}
                collapsedTeamIds={collapsedTeamIds}
                depth={0}
                key={team.id}
                currentUser={currentUser}
                onActiveChange={onTeamActiveChange}
                onDelete={onDelete}
                onEdit={openEditTeamDialog}
                onToggle={toggleTeam}
                team={team}
              />
            ))}
          </div>
        ) : (
          <p>No team hierarchy available.</p>
        )}
      </div>
      {teamDialogOpen ? (
        <div className="management-modal-backdrop">
          <section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="team-dialog-title">
            <div className="management-modal-heading">
              <div>
                <span>Team info</span>
                <h3 id="team-dialog-title">{editingTeam ? 'Edit team' : 'Add team'}</h3>
              </div>
              <button type="button" onClick={closeTeamDialog}>Cancel</button>
            </div>
            <form className="management-form management-modal-form" onSubmit={handleTeamFormSubmit}>
              <label>
                <span>Team name</span>
                <input required value={teamForm.name} onChange={(event) => setTeamForm({ ...teamForm, name: event.target.value })} />
              </label>
              <label>
                <span>Description</span>
                <input value={teamForm.description} onChange={(event) => setTeamForm({ ...teamForm, description: event.target.value })} />
              </label>
              <label>
                <span>Parent team</span>
                <select value={teamForm.parent_team_id} onChange={(event) => setTeamForm({ ...teamForm, parent_team_id: event.target.value })}>
                  <option value="">No parent team</option>
                  {parentTeamOptions.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              </label>
              <label>
                <span>Manager</span>
                <select value={teamForm.manager_user_id} onChange={(event) => setTeamForm({ ...teamForm, manager_user_id: event.target.value })}>
                  <option value="">No manager</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}
                </select>
              </label>
              <label className="management-inline-check">
                <input checked={teamForm.is_active} onChange={(event) => setTeamForm({ ...teamForm, is_active: event.target.checked })} type="checkbox" />
                Active
              </label>
              <div className="management-modal-actions">
                <button type="button" onClick={closeTeamDialog}>Cancel</button>
                <button className="management-primary-button" type="submit">
                  <Save size={16} />
                  {editingTeam ? 'Save team' : 'Create team'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  )
}

function TeamTreeRows({
  childTeams,
  collapsedTeamIds,
  currentUser,
  depth,
  onActiveChange,
  onDelete,
  onEdit,
  onToggle,
  team,
}: {
  childTeams: Map<number | null, PortalTeam[]>
  collapsedTeamIds: Set<number>
  currentUser: PortalUser
  depth: number
  onActiveChange: (teamId: number, isActive: boolean) => Promise<void>
  onDelete: (teamId: number) => Promise<void>
  onEdit: (team: PortalTeam) => void
  onToggle: (teamId: number) => void
  team: PortalTeam
}) {
  const children = childTeams.get(team.id) ?? []
  const isCollapsed = collapsedTeamIds.has(team.id)
  const hasChildren = children.length > 0

  return (
    <>
      <div className="management-team-tree-row" role="row" style={{ '--team-depth': depth } as CSSProperties}>
        <div className="management-team-main" role="gridcell">
          <span className="management-team-indent" aria-hidden="true" />
          <button
            className="management-tree-toggle"
            disabled={!hasChildren}
            type="button"
            aria-label={isCollapsed ? `Expand ${team.name}` : `Collapse ${team.name}`}
            onClick={() => onToggle(team.id)}
          >
            {hasChildren ? (isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />) : <span />}
          </button>
          <Building2 size={16} aria-hidden="true" />
          <strong>{team.name}</strong>
        </div>
        <div className="management-team-manager" role="gridcell">
          <UserCog size={15} aria-hidden="true" />
          <span>{team.manager_name ?? '-'}</span>
        </div>
        <div className="management-team-members" role="gridcell">
          <Users size={15} aria-hidden="true" />
          <span>{team.member_count}</span>
        </div>
        <div className="management-team-status" role="gridcell">
          <span className={team.is_active ? 'active' : 'disabled'}>{team.is_active ? 'Active' : 'Disabled'}</span>
        </div>
        <div className="management-team-actions" role="gridcell">
          <button type="button" onClick={() => onActiveChange(team.id, !team.is_active)}>
            {team.is_active ? 'Disable' : 'Enable'}
          </button>
          <button type="button" onClick={() => onEdit(team)}>
            <Pencil size={14} />
            Edit
          </button>
          {canUseSystemAdmin(currentUser) ? (
            <button type="button" onClick={() => onDelete(team.id)}>
              Delete
            </button>
          ) : null}
        </div>
      </div>
      {hasChildren && !isCollapsed
        ? children.map((child) => (
            <TeamTreeRows
              childTeams={childTeams}
              collapsedTeamIds={collapsedTeamIds}
              currentUser={currentUser}
              depth={depth + 1}
              key={child.id}
              onActiveChange={onActiveChange}
              onDelete={onDelete}
              onEdit={onEdit}
              onToggle={onToggle}
              team={child}
            />
          ))
        : null}
    </>
  )
}

function discoveryActionsFor(item: ResourceDiscoveryItem): ResourceDiscoveryAction['action'][] {
  if (item.status === 'new') return ['add']
  if (item.status === 'changed') return ['update']
  if (item.status === 'stale') return ['disable']
  return []
}

function discoveryChangeSummary(item: ResourceDiscoveryItem) {
  const fields = Object.keys(item.changes)
  if (!fields.length) return '-'
  return fields.join(', ')
}

function discoveryNoActionText(item: ResourceDiscoveryItem) {
  if (item.status === 'unchanged') return 'No action needed'
  if (item.status === 'inactive_stale') return 'Already disabled'
  if (item.status === 'conflict') return 'Review saved resource'
  return 'No action available'
}

function DiscoveryStatus({ item }: { item: ResourceDiscoveryItem }) {
  const isWarning = item.status === 'conflict' || item.status === 'stale'
  return (
    <span className={`management-discovery-status ${item.status}`}>
      {isWarning ? <AlertTriangle size={13} /> : null}
      {item.status.replace('_', ' ')}
    </span>
  )
}

function permissionSubjectLabel(subject: PortalTeam | PortalUser) {
  return 'display_name' in subject ? subject.display_name : subject.name
}

function permissionSubjectDetail(subject: PortalTeam | PortalUser) {
  if ('email' in subject) return subject.email
  return subject.manager_name ? `Manager: ${subject.manager_name}` : ''
}

function permissionSubjectSearchText(subject: PortalTeam | PortalUser) {
  if ('email' in subject) {
    return [subject.display_name, subject.email, subject.employee_id, subject.team_name].join(' ').toLowerCase()
  }
  return [subject.name, subject.manager_name].join(' ').toLowerCase()
}

function SubjectSearchBox({
  placeholder,
  subjects,
  value,
  onChange,
}: {
  placeholder: string
  subjects: Array<PortalTeam | PortalUser>
  value: string
  onChange: (subjectId: string) => void
}) {
  const selectedSubject = subjects.find((subject) => String(subject.id) === value)
  const [query, setQuery] = useState(() => (selectedSubject ? permissionSubjectLabel(selectedSubject) : ''))
  const [open, setOpen] = useState(false)
  const filteredSubjects = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return subjects.slice(0, 40)
    return subjects.filter((subject) => permissionSubjectSearchText(subject).includes(term)).slice(0, 40)
  }, [query, subjects])

  useEffect(() => {
    setQuery(selectedSubject ? permissionSubjectLabel(selectedSubject) : '')
  }, [selectedSubject])

  function chooseSubject(subject: PortalTeam | PortalUser) {
    onChange(String(subject.id))
    setQuery(permissionSubjectLabel(subject))
    setOpen(false)
  }

  return (
    <div className="management-subject-combobox">
      <input
        aria-autocomplete="list"
        aria-expanded={open}
        autoComplete="off"
        disabled={!subjects.length}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        role="combobox"
        value={query}
      />
      <ChevronDown size={16} aria-hidden="true" />
      {open ? (
        <div className="management-subject-options" role="listbox">
          {filteredSubjects.length ? filteredSubjects.map((subject) => (
            <button
              className={String(subject.id) === value ? 'active' : ''}
              key={subject.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseSubject(subject)}
              type="button"
            >
              <span>{permissionSubjectLabel(subject)}</span>
              {permissionSubjectDetail(subject) ? <small>{permissionSubjectDetail(subject)}</small> : null}
            </button>
          )) : (
            <span className="management-subject-empty">No matches</span>
          )}
        </div>
      ) : null}
    </div>
  )
}

function matchesTextFilter(values: Array<string | null | undefined>, filter: string) {
  const term = filter.trim().toLowerCase()
  if (!term) return true
  return values.some((value) => (value ?? '').toLowerCase().includes(term))
}

function ResourcesPanel({
  currentUser,
  resources,
  summary,
  onDelete,
  onRefresh,
  onResourceFlagChange,
}: {
  currentUser: PortalUser
  resources: PortalResource[]
  summary: AdminSummary | null
  onDelete: (resourceId: number) => Promise<void>
  onRefresh: () => Promise<void>
  onResourceFlagChange: (resourceId: number, payload: Partial<PortalResource>) => Promise<void>
}) {
  const [discoveryItems, setDiscoveryItems] = useState<ResourceDiscoveryItem[]>([])
  const [discoveryCounts, setDiscoveryCounts] = useState<Record<string, number>>({})
  const [discoverySelections, setDiscoverySelections] = useState<Record<string, DiscoverySelection>>({})
  const [discoveryStatus, setDiscoveryStatus] = useState('')
  const [discoveryError, setDiscoveryError] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [resourceTypeFilter, setResourceTypeFilter] = useState('')
  const [resourceTextFilter, setResourceTextFilter] = useState('')
  const [resourceActiveFilter, setResourceActiveFilter] = useState('')
  const [discoveryStatusFilter, setDiscoveryStatusFilter] = useState('')
  const [discoverySourceFilter, setDiscoverySourceFilter] = useState('')
  const selectedDiscoveryActions = useMemo<ResourceDiscoveryAction[]>(
    () =>
      Object.entries(discoverySelections)
        .filter((entry): entry is [string, ResourceDiscoveryAction['action']] => Boolean(entry[1]))
        .map(([resource_key, action]) => ({ resource_key, action })),
    [discoverySelections],
  )
  const filteredDiscoveryItems = useMemo(
    () =>
      discoveryItems.filter((item) => {
        if (resourceTypeFilter && item.resource_type !== resourceTypeFilter) return false
        if (discoveryStatusFilter && item.status !== discoveryStatusFilter) return false
        if (discoverySourceFilter && item.source !== discoverySourceFilter) return false
        return matchesTextFilter([item.name, item.url, item.resource_key, item.category, item.description], resourceTextFilter)
      }),
    [discoveryItems, discoverySourceFilter, discoveryStatusFilter, resourceTextFilter, resourceTypeFilter],
  )
  const filteredResources = useMemo(
    () =>
      resources.filter((resource) => {
        if (resourceTypeFilter && resource.resource_type !== resourceTypeFilter) return false
        if (resourceActiveFilter === 'active' && !resource.is_active) return false
        if (resourceActiveFilter === 'inactive' && resource.is_active) return false
        if (resourceActiveFilter === 'public' && !resource.is_public) return false
        if (resourceActiveFilter === 'private' && resource.is_public) return false
        return matchesTextFilter([resource.name, resource.url, resource.resource_key, resource.category, resource.description], resourceTextFilter)
      }),
    [resourceActiveFilter, resourceTextFilter, resourceTypeFilter, resources],
  )
  const discoverySources = useMemo(() => Array.from(new Set(discoveryItems.map((item) => item.source))).sort(), [discoveryItems])
  const discoveryStatuses = useMemo(() => Array.from(new Set(discoveryItems.map((item) => item.status))).sort(), [discoveryItems])

  function defaultDiscoveryAction(item: ResourceDiscoveryItem): DiscoverySelection {
    if (item.status === 'new' && item.resource_type !== 'api') return 'add'
    if (item.status === 'changed') return 'update'
    return ''
  }

  function setDiscoveryReview(items: ResourceDiscoveryItem[], counts: Record<string, number>) {
    const selections: Record<string, DiscoverySelection> = {}
    for (const item of items) {
      selections[item.resource_key] = defaultDiscoveryAction(item)
    }
    setDiscoveryItems(items)
    setDiscoveryCounts(counts)
    setDiscoverySelections(selections)
  }

  async function handleDiscoverResources() {
    setDiscovering(true)
    setDiscoveryError('')
    setDiscoveryStatus('')
    try {
      const response = await discoverResources()
      setDiscoveryReview(response.resources, response.counts)
      setDiscoveryStatus(`${response.resources.length} URLs reviewed.`)
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'Could not discover resources.')
    } finally {
      setDiscovering(false)
    }
  }

  async function handleApplyDiscovery() {
    if (!selectedDiscoveryActions.length) return
    setDiscovering(true)
    setDiscoveryError('')
    setDiscoveryStatus('')
    try {
      const response = await applyResourceDiscovery(selectedDiscoveryActions)
      setDiscoveryReview(response.discovery.resources, response.discovery.counts)
      await onRefresh()
      const skippedText = response.skipped.length ? ` ${response.skipped.length} skipped.` : ''
      setDiscoveryStatus(`${response.applied.length} discovery actions applied.${skippedText}`)
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'Could not apply discovery actions.')
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <section className="management-panel">
      <div className="management-panel-heading">
        <h2>Resources</h2>
        <div className="management-panel-heading-actions">
          <span>{summary ? `${summary.resources} resources, ${summary.permissions} permissions` : `${resources.length} resources`}</span>
          <button type="button" onClick={handleDiscoverResources} disabled={discovering}>
            <RefreshCw size={16} />
            Discover resources
          </button>
        </div>
      </div>
      <div className="management-resource-filters">
        <input value={resourceTextFilter} onChange={(event) => setResourceTextFilter(event.target.value)} placeholder="Filter name, URL, key, category" />
        <select value={resourceTypeFilter} onChange={(event) => setResourceTypeFilter(event.target.value)}>
          <option value="">All resource types</option>
          {RESOURCE_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <select value={resourceActiveFilter} onChange={(event) => setResourceActiveFilter(event.target.value)}>
          <option value="">All saved resources</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
          <option value="public">Public only</option>
          <option value="private">Private only</option>
        </select>
        <select value={discoveryStatusFilter} onChange={(event) => setDiscoveryStatusFilter(event.target.value)}>
          <option value="">All discovery statuses</option>
          {discoveryStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <select value={discoverySourceFilter} onChange={(event) => setDiscoverySourceFilter(event.target.value)}>
          <option value="">All discovery sources</option>
          {discoverySources.map((source) => <option key={source} value={source}>{source}</option>)}
        </select>
      </div>
      {discoveryItems.length ? (
        <div className="management-discovery">
          <div className="management-discovery-heading">
            <div>
              <strong>Discovered URLs</strong>
              <span>{filteredDiscoveryItems.length} shown | {Object.entries(discoveryCounts).map(([status, count]) => `${status}: ${count}`).join('  |  ')}</span>
            </div>
            <button className="management-primary-button" type="button" onClick={handleApplyDiscovery} disabled={!selectedDiscoveryActions.length || discovering}>
              <Save size={16} />
              Apply selected
            </button>
          </div>
          {discoveryStatus ? <div className="management-status">{discoveryStatus}</div> : null}
          {discoveryError ? <div className="management-error">{discoveryError}</div> : null}
          <div className="management-table-wrap">
            <table className="management-discovery-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Source</th>
                  <th>Changes</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredDiscoveryItems.map((item) => {
                  const actions = discoveryActionsFor(item)
                  return (
                    <tr key={item.resource_key}>
                      <td><DiscoveryStatus item={item} /></td>
                      <td>{item.resource_type}</td>
                      <td>{item.name}</td>
                      <td><code>{item.url}</code></td>
                      <td>{item.source}</td>
                      <td>{discoveryChangeSummary(item)}</td>
                      <td>
                        {actions.length ? (
                          <select
                            value={discoverySelections[item.resource_key] ?? ''}
                            onChange={(event) => setDiscoverySelections((current) => ({ ...current, [item.resource_key]: event.target.value as DiscoverySelection }))}
                          >
                            <option value="">Ignore</option>
                            {actions.map((action) => <option key={action} value={action}>{action}</option>)}
                          </select>
                        ) : (
                          <span className="management-discovery-no-action">{discoveryNoActionText(item)}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <div className="management-table-wrap">
        <div className="management-table-caption">{filteredResources.length} saved resources shown</div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>URL</th>
              <th>Public</th>
              <th>Active</th>
              {canUseSystemAdmin(currentUser) ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {filteredResources.map((resource) => (
              <tr key={resource.id}>
                <td>{resource.name}</td>
                <td>{resource.resource_type}</td>
                <td><a href={resource.url}>{resource.url}</a></td>
                <td><input checked={resource.is_public} onChange={(event) => onResourceFlagChange(resource.id, { is_public: event.target.checked })} type="checkbox" /></td>
                <td><input checked={resource.is_active} onChange={(event) => onResourceFlagChange(resource.id, { is_active: event.target.checked })} type="checkbox" /></td>
                {canUseSystemAdmin(currentUser) ? (
                  <td>
                    <button type="button" onClick={() => onDelete(resource.id)}>Delete</button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PermissionsPanel({
  currentUser,
  newPermissionLevel,
  newPermissionSubject,
  newPermissionType,
  permissions,
  resources,
  selectedResourceId,
  teams,
  users,
  onAdd,
  onLevelChange,
  onPermissionChange,
  onRemove,
  onResourceChange,
  onSave,
  onSubjectChange,
  onTypeChange,
}: {
  currentUser: PortalUser
  newPermissionLevel: number
  newPermissionSubject: string
  newPermissionType: 'team' | 'user'
  permissions: PermissionDraft[]
  resources: PortalResource[]
  selectedResourceId: number | null
  teams: PortalTeam[]
  users: PortalUser[]
  onAdd: () => void
  onLevelChange: (level: number) => void
  onPermissionChange: (permissions: PermissionDraft[]) => void
  onRemove: (index: number) => void
  onResourceChange: (resourceId: string) => void
  onSave: () => void
  onSubjectChange: (subjectId: string) => void
  onTypeChange: (type: 'team' | 'user') => void
}) {
  const [permissionMode, setPermissionMode] = useState<'bulk' | 'resource'>('bulk')
  const [bulkSubjectType, setBulkSubjectType] = useState<'team' | 'user'>('team')
  const [bulkSubjectId, setBulkSubjectId] = useState('')
  const [bulkSearch, setBulkSearch] = useState('')
  const [bulkResourceType, setBulkResourceType] = useState('')
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkIncludeInactive, setBulkIncludeInactive] = useState(false)
  const [bulkRows, setBulkRows] = useState<BulkPermissionRow[]>([])
  const [bulkDrafts, setBulkDrafts] = useState<Record<number, string>>({})
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<number>>(() => new Set())
  const [bulkStatus, setBulkStatus] = useState('')
  const [bulkError, setBulkError] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkLoaded, setBulkLoaded] = useState(false)
  const bulkSubjects = bulkSubjectType === 'team' ? teams : users
  const categoryOptions = useMemo(
    () => Array.from(new Set(resources.map((resource) => resource.category).filter(Boolean) as string[])).sort(),
    [resources],
  )
  const changedBulkAssignments = useMemo<BulkPermissionAssignment[]>(
    () =>
      bulkRows
        .filter((row) => {
          const original = row.direct_permission_level == null ? '' : String(row.direct_permission_level)
          return (bulkDrafts[row.resource.id] ?? '') !== original
        })
        .map((row) => {
          const draft = bulkDrafts[row.resource.id] ?? ''
          return {
            resource_id: row.resource.id,
            permission_level: draft ? Number(draft) : null,
          }
        }),
    [bulkDrafts, bulkRows],
  )

  useEffect(() => {
    if (!bulkSubjects.length) {
      setBulkSubjectId('')
      return
    }
    if (!bulkSubjects.some((subject) => String(subject.id) === bulkSubjectId)) {
      setBulkSubjectId(String(bulkSubjects[0].id))
    }
  }, [bulkSubjectId, bulkSubjects])

  function applyBulkRows(rows: BulkPermissionRow[]) {
    const drafts: Record<number, string> = {}
    for (const row of rows) {
      drafts[row.resource.id] = row.direct_permission_level == null ? '' : String(row.direct_permission_level)
    }
    setBulkRows(rows)
    setBulkDrafts(drafts)
    setBulkSelectedIds(new Set())
  }

  async function loadBulkPermissions() {
    if (!bulkSubjectId) {
      setBulkError('Select a team or user first.')
      return
    }
    setBulkLoading(true)
    setBulkError('')
    setBulkStatus('')
    try {
      const response = await fetchPermissionMatrix({
        subject_type: bulkSubjectType,
        subject_id: Number(bulkSubjectId),
        search: bulkSearch,
        resource_type: bulkResourceType,
        category: bulkCategory,
        include_inactive: bulkIncludeInactive,
      })
      applyBulkRows(response.rows)
      setBulkLoaded(true)
      setBulkStatus(`${response.rows.length} resources loaded.`)
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : 'Could not load bulk permissions.')
    } finally {
      setBulkLoading(false)
    }
  }

  useEffect(() => {
    if (permissionMode !== 'bulk' || !bulkSubjectId) return
    const timer = window.setTimeout(() => {
      void loadBulkPermissions()
    }, 250)
    return () => window.clearTimeout(timer)
  }, [bulkCategory, bulkIncludeInactive, bulkResourceType, bulkSearch, bulkSubjectId, bulkSubjectType, permissionMode])

  async function saveBulkPermissions() {
    if (!bulkSubjectId || !changedBulkAssignments.length) return
    setBulkLoading(true)
    setBulkError('')
    setBulkStatus('')
    try {
      const response = await updatePermissionMatrix({
        subject_type: bulkSubjectType,
        subject_id: Number(bulkSubjectId),
        assignments: changedBulkAssignments,
      })
      setBulkStatus(`${response.created} created, ${response.updated} updated, ${response.deleted} cleared.`)
      await loadBulkPermissions()
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : 'Could not save bulk permissions.')
    } finally {
      setBulkLoading(false)
    }
  }

  function toggleBulkSelected(resourceId: number) {
    setBulkSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(resourceId)) {
        next.delete(resourceId)
      } else {
        next.add(resourceId)
      }
      return next
    })
  }

  function setSelectedBulkPermission(level: string) {
    if (!bulkSelectedIds.size) return
    setBulkDrafts((current) => {
      const next = { ...current }
      for (const resourceId of bulkSelectedIds) next[resourceId] = level
      return next
    })
  }

  function bulkPermissionLabel(level: number | null | undefined, fallback = '-') {
    if (level == null) return fallback
    return PERMISSION_OPTIONS.find((option) => option.value === level)?.label ?? String(level)
  }

  return (
    <section className="management-panel">
      <div className="management-panel-heading">
        <h2>Permissions</h2>
        <div className="management-panel-heading-actions">
          <button className={permissionMode === 'bulk' ? 'management-primary-button' : ''} type="button" onClick={() => setPermissionMode('bulk')}>
            Bulk permissions
          </button>
          <button className={permissionMode === 'resource' ? 'management-primary-button' : ''} type="button" onClick={() => setPermissionMode('resource')}>
            Resource detail
          </button>
          {permissionMode === 'resource' ? (
            <button className="management-primary-button" type="button" onClick={onSave}>
              <Save size={16} />
              Save permissions
            </button>
          ) : null}
        </div>
      </div>
      {permissionMode === 'bulk' ? (
        <>
          <div className="management-permission-bulk-toolbar">
            <select value={bulkSubjectType} onChange={(event) => setBulkSubjectType(event.target.value as 'team' | 'user')}>
              <option value="team">Team</option>
              <option value="user">User</option>
            </select>
            <SubjectSearchBox
              onChange={setBulkSubjectId}
              placeholder={bulkSubjectType === 'user' ? 'Search user name' : 'Search team name'}
              subjects={bulkSubjects}
              value={bulkSubjectId}
            />
            <input value={bulkSearch} onChange={(event) => setBulkSearch(event.target.value)} placeholder="Filter resource name, URL, key" />
            <select value={bulkResourceType} onChange={(event) => setBulkResourceType(event.target.value)}>
              <option value="">All types</option>
              {RESOURCE_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <select value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)}>
              <option value="">All categories</option>
              {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
            <label className="management-inline-check">
              <input checked={bulkIncludeInactive} onChange={(event) => setBulkIncludeInactive(event.target.checked)} type="checkbox" />
              Include inactive
            </label>
            <button type="button" onClick={loadBulkPermissions} disabled={bulkLoading}>
              <RefreshCw size={16} />
              Load
            </button>
          </div>
          <div className="management-permission-bulk-actions">
            <span>{bulkSelectedIds.size} selected, {changedBulkAssignments.length} changed</span>
            <button type="button" onClick={() => setBulkSelectedIds(new Set(bulkRows.map((row) => row.resource.id)))}>Select all shown</button>
            <button type="button" onClick={() => setBulkSelectedIds(new Set())}>Clear selection</button>
            {PERMISSION_OPTIONS.map((option) => (
              <button key={option.value} type="button" onClick={() => setSelectedBulkPermission(String(option.value))}>
                Set {option.label}
              </button>
            ))}
            <button type="button" onClick={() => setSelectedBulkPermission('')}>Clear permission</button>
            <button className="management-primary-button" type="button" onClick={saveBulkPermissions} disabled={!changedBulkAssignments.length || bulkLoading}>
              <Save size={16} />
              Save changes
            </button>
          </div>
          {bulkStatus ? <div className="management-status">{bulkStatus}</div> : null}
          {bulkError ? <div className="management-error">{bulkError}</div> : null}
          <div className="management-table-wrap">
            <table className="management-permission-matrix">
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Resource</th>
                  <th>Type</th>
                  <th>Category</th>
                  <th>Effective</th>
                  <th>Direct permission</th>
                </tr>
              </thead>
              <tbody>
                {bulkRows.map((row) => (
                  <tr key={row.resource.id}>
                    <td>
                      <input checked={bulkSelectedIds.has(row.resource.id)} onChange={() => toggleBulkSelected(row.resource.id)} type="checkbox" />
                    </td>
                    <td>
                      <strong>{row.resource.name}</strong>
                      <small>{row.resource.url}</small>
                    </td>
                    <td>{row.resource.resource_type}</td>
                    <td>{row.resource.category ?? '-'}</td>
                    <td>
                      {row.effective_permission
                        ? `${bulkPermissionLabel(row.effective_permission.permission_level)} (${row.effective_permission.source})`
                        : '-'}
                    </td>
                    <td>
                      <select
                        value={bulkDrafts[row.resource.id] ?? ''}
                        onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.resource.id]: event.target.value }))}
                      >
                        <option value="">No direct permission</option>
                        {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
                {!bulkRows.length ? (
                  <tr>
                    <td colSpan={6}>{bulkLoaded ? 'No resources match the current filters.' : 'Loading resources...'}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="management-permission-toolbar">
            <select value={selectedResourceId ?? ''} onChange={(event) => onResourceChange(event.target.value)}>
              {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
            </select>
            <select value={newPermissionType} onChange={(event) => onTypeChange(event.target.value as 'team' | 'user')}>
              <option value="team">Team</option>
              <option value="user">User</option>
            </select>
            <select value={newPermissionSubject} onChange={(event) => onSubjectChange(event.target.value)}>
              <option value="">Select {newPermissionType}</option>
              {(newPermissionType === 'team' ? teams : users).map((item) => (
                <option key={item.id} value={item.id}>{'display_name' in item ? item.display_name : item.name}</option>
              ))}
            </select>
            <select value={newPermissionLevel} onChange={(event) => onLevelChange(Number(event.target.value))}>
              {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button type="button" onClick={onAdd}>
              <Plus size={16} />
              Add
            </button>
          </div>
          <div className="management-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Type</th>
                  <th>Permission</th>
                  {canUseSystemAdmin(currentUser) ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {permissions.map((permission, index) => {
                  const user = users.find((item) => item.id === permission.user_id)
                  const team = teams.find((item) => item.id === permission.team_id)
                  return (
                    <tr key={`${permission.user_id ?? 'team'}-${permission.team_id ?? 'user'}-${index}`}>
                      <td>{user?.display_name ?? team?.name ?? 'Unknown'}</td>
                      <td>{permission.user_id ? 'User exception' : 'Team'}</td>
                      <td>
                        <select
                          value={permission.permission_level}
                          onChange={(event) =>
                            onPermissionChange(
                              permissions.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, permission_level: Number(event.target.value) } : item,
                              ),
                            )
                          }
                        >
                          {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </td>
                      {canUseSystemAdmin(currentUser) ? (
                        <td><button type="button" onClick={() => onRemove(index)}>Remove</button></td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function AuditPanel({ logs }: { logs: AuditLog[] }) {
  return (
    <section className="management-panel">
      <div className="management-panel-heading">
        <h2>Audit Logs</h2>
        <span>{logs.length} recent events</span>
      </div>
      <div className="management-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{formatDate(log.created_at)}</td>
                <td>{log.action}</td>
                <td>{log.target_type} {log.target_id ?? ''}</td>
                <td><code>{log.details_json ?? '{}'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="management-detail">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ResourcePill({ resource }: { resource: PortalResource }) {
  return (
    <a className="management-resource-pill" href={resource.url}>
      <span>{resource.resource_type}</span>
      <strong>{resource.name}</strong>
    </a>
  )
}
