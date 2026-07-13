# Portal Management Module Design

## Goal

Build a management module for the Portal that supports user management, team management, permission management, resource management, and password reset workflows.

The first implementation should use SQLite as the management database. The design should stay simple, explicit, and easy to audit.

## Main Concepts

### Users

Each user represents one login identity.

Suggested user data:

- Username
- First name
- Last name
- Email
- Employee ID
- Team
- Active or disabled status
- Password hash
- System admin flag
- Portal admin flag
- Must-change-password flag
- Created and updated timestamps

The display name can be generated from first name and last name. The login username can be a separate field, or it can be based on email or employee ID depending on City standards.

Each person belongs to one primary team in the first version.

Passwords should never be stored as plain text. Use a strong password hashing algorithm such as bcrypt or Argon2.

Each user should be able to view their own profile information, including name, email, employee ID, team, manager, and account status. Users should not be able to edit privileged fields such as team, system admin status, or permissions unless they have management access.

When a user account is created, the initial temporary password should be the user's employee ID. The system should hash this value before storing it and set `must_change_password = true` so the user must create a new password on first login.

### Management Roles

Keep global management roles separate from resource permissions.

Suggested global roles:

- `system_admin`: Protected bootstrap/superuser account. This user can manage everything and cannot be deleted, deactivated, or demoted through the application.
- `admin`: Portal management user. This user can manage users, teams, resources, and permissions, but can be deleted, deactivated, or demoted by a system admin.
- Normal user: Can view their own profile, change their password, pin featured resources, and access resources based on public access plus direct/team permissions.

Recommended rules:

- At least one active system admin must always exist.
- System admins cannot be deleted.
- System admins should not be deactivated.
- System admins should not be demoted through normal UI actions.
- Only system admins can create, delete, activate, deactivate, promote, or demote portal admins.
- Portal admins can manage normal users, teams, resources, and permissions.
- Portal admins should not be allowed to modify system admin accounts.
- Portal admins should not be allowed to grant system admin access.
- Delete should normally be implemented as soft delete by setting `deleted_at`, not by immediately removing the database row.

### Teams

Teams organize users and can be nested.

A team may belong to another team through `parent_team_id`.

Example hierarchy:

```text
Storm Water
Critical Asset Team
Field Review Group
```

For the first version, each user has one `team_id`.

Each team has one manager through `manager_user_id`.

Team hierarchy rules:

- A team cannot be its own parent.
- A team cannot be assigned to one of its descendants.
- Users in child teams may inherit permissions from parent teams.
- A team manager should usually be an active user assigned to that team.
- A team may temporarily have no manager during setup or data import.
- Managers of parent teams may manage child teams if the policy allows it.

SQLite recursive CTE queries can be used to resolve parent and child team relationships.

### Resources

Each Portal item should have one resource record.

Examples:

```text
/dashboard_critical_team_overview
/map_stm_risk
/tab_asset_inventory
/doc_cctv_review_guide
```

Suggested resource fields:

- Name
- Resource type
- URL
- Description
- Public access flag
- Active flag
- Created and updated timestamps

Suggested resource types:

- `dashboard`
- `map`
- `tab`
- `doc`
- `admin`
- `api`

Some resources may allow public access. Public resources should be visible without a user-specific permission assignment.

### Featured Items

Users should be able to customize their own featured resource items. These behave like pinned resources on the Portal home page.

Featured items should reference existing resources instead of duplicating resource data.

Suggested behavior:

- A user can pin resources they are allowed to access.
- A user can unpin their own featured resources.
- A user can reorder their featured resources.
- If a resource is disabled or the user loses access, it should not appear in their featured list.
- Public resources can be pinned by any user.
- Admins may optionally configure default featured resources later.

### Permissions

Use resource-level access rules. Permissions can be assigned directly to users or to teams.

Recommendation: use team-based permission management as the default. Individual user permissions should be used only for exceptions, temporary access, testing, or special admin cases.

Supported permission types:

- `view`
- `edit`
- `review`
- `create`
- `delete`
- `manage`
- `admin`

A user or team may hold multiple permission types for the same resource.

For most Portal dashboards, maps, tables, and documents, `view` will be enough.

Avoid deny rules in the first version. Allow-only permissions are easier to understand, test, and audit.

Suggested permission policy:

- Grant resource access to teams whenever possible.
- Let child teams inherit permissions from parent teams.
- Use individual permissions only when one user needs access different from their team.
- Show both assigned permission and effective permission in the management UI.
- Show where effective access comes from: public, direct user permission, team permission, inherited parent team permission, portal admin, or system admin.
- Public resources grant view access only. Edit, review, create, delete, manage, and admin capabilities still require explicit permission.
- Permission changes should always write an audit log entry.

## Access Decision Rule

When a user requests a resource:

1. If the resource is public, allow view access.
2. If the user is a system admin, allow all access.
3. If the request is for a management function and the user is a portal admin, allow management access, except for protected system admin actions.
4. Check permissions from the user's team.
5. Include permissions inherited from parent teams.
6. Check direct user permissions for the resource.
7. Combine all permission types found into the effective permission set.

If no matching permission is found, deny access.

## Suggested SQLite Tables

Core tables:

```text
SYS_USERS
SYS_TEAMS
SYS_RESOURCES
SYS_RESOURCE_PERMISSIONS
SYS_USER_FEATURED_RESOURCES
SYS_TEAM_FEATURED_RESOURCES
SYS_PASSWORD_RESET_TOKENS
SYS_AUDIT_LOGS
```

Optional later tables:

```text
roles
role_permissions
user_sessions
resource_groups
team_memberships
```

Do not add generic roles or many-team membership in the first version unless they are clearly needed. A single primary team per user plus team-based resource permissions should fit the Portal well.

## Database Structure Maintenance

Use SQLAlchemy to define the SQLite database schema in Python, and use Alembic to maintain database structure changes over time.

Alembic is the standard database migration tool for SQLAlchemy. It can compare the current SQLAlchemy model definitions with the current database structure and generate candidate migration scripts.

Recommended packages:

```text
SQLAlchemy
Alembic
```

Suggested project structure:

```text
backend/app/management/
models.py
database.py
services.py
routers.py

backend/migrations/
env.py
versions/
```

Typical migration workflow:

```powershell
alembic revision --autogenerate -m "create management tables"
alembic upgrade head
```

Recommended rules:

- Define the intended schema in SQLAlchemy models.
- Use Alembic autogenerate to create migration scripts.
- Review every generated migration before applying it.
- Commit migration scripts with the source code.
- Use `alembic upgrade head` when starting or deploying the backend.
- Do not manually edit the production SQLite schema outside migrations.

SQLite note:

SQLite has limited `ALTER TABLE` support compared with full database servers. Alembic supports batch migrations, which can safely handle many SQLite schema changes by recreating tables behind the scenes when needed. This is especially useful for later changes such as renaming columns, dropping columns, or changing constraints.

Alembic autogenerate is helpful, but it is not perfect. It usually detects obvious table, column, index, and constraint changes, but it may not understand every data migration or semantic change. Data corrections and default admin/user seed data may need explicit migration logic.

## Detailed Table Design

SQLite should run with foreign keys enabled:

```sql
PRAGMA foreign_keys = ON;
```

SQLite stores booleans as integers, so boolean fields use `0` and `1` with `CHECK` constraints.

Permission types use bit values so multiple capabilities can be stored in one assignment and combined efficiently:

```text
1  = view
2  = edit
4  = review
8  = create
16 = delete
32 = manage
64 = admin
```

### SYS_TEAMS

```sql
CREATE TABLE SYS_TEAMS (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_team_id INTEGER,
  manager_user_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_team_id) REFERENCES SYS_TEAMS(id) ON DELETE SET NULL,
  FOREIGN KEY (manager_user_id) REFERENCES SYS_USERS(id) ON DELETE SET NULL,
  CHECK (parent_team_id IS NULL OR parent_team_id <> id)
);
```

Notes:

- `parent_team_id` supports team hierarchy.
- `manager_user_id` stores the manager for the team.
- `manager_user_id` can be null during setup or data import.
- The backend should prevent descendant cycles when changing `parent_team_id`.
- The backend should normally require the manager to be an active user assigned to the same team.

### SYS_USERS

```sql
CREATE TABLE SYS_USERS (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  employee_id TEXT NOT NULL UNIQUE,
  team_id INTEGER,
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_system_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_system_admin IN (0, 1)),
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  password_changed_at TEXT,
  deleted_at TEXT,
  deleted_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES SYS_TEAMS(id) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by_user_id) REFERENCES SYS_USERS(id) ON DELETE SET NULL,
  CHECK (is_system_admin = 0 OR is_active = 1),
  CHECK (is_system_admin = 0 OR deleted_at IS NULL)
);
```

Notes:

- `employee_id` is unique and is used as the initial temporary password value.
- The employee ID must be hashed into `password_hash`; never store it as plain text password data.
- New users should start with `must_change_password = 1`.
- `team_id` should be required for normal active users.
- An initial system admin account may temporarily have no team during setup.
- `is_system_admin` is for protected bootstrap/superuser accounts.
- `is_admin` is for portal management users who can manage users, teams, resources, and permissions.
- Admin users can be soft-deleted by a system admin.
- System admins cannot be soft-deleted or deactivated.
- `deleted_at` supports soft delete while keeping audit history and foreign key references understandable.

### protected system admin trigger

```sql
CREATE TRIGGER prevent_sys_system_admin_delete
BEFORE DELETE ON SYS_USERS
WHEN OLD.is_system_admin = 1
BEGIN
  SELECT RAISE(ABORT, 'system admin users cannot be deleted');
END;
```

This trigger protects system admin users if a future maintenance script or admin API attempts a hard delete. Normal application delete actions should still use soft delete by setting `deleted_at`.

### SYS_RESOURCES

```sql
CREATE TABLE SYS_RESOURCES (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL UNIQUE CHECK (
    resource_id GLOB '[A-Z][A-Z][A-Z][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'
  ),
  resource_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (
    resource_type IN ('dashboard', 'map', 'tab', 'doc', 'report', 'dataset', 'service', 'admin', 'api')
  ),
  url TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT,
  icon TEXT,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Notes:

- `resource_id` is the official 8-character resource ID shown to admins and used for resource search. It is declared by the resource itself.
- `resource_key` should be a stable identifier, such as `map_stm_risk`.
- `url` is the route path, such as `/map_stm_risk`.
- Public resources do not need explicit user or team permissions for view access.
- Disabled resources should not appear in the portal catalog or featured items.

Resource ID format:

- `DAS` plus five random uppercase letters or digits: dashboard resources, such as `DASXKG5R`.
- `MAP` plus five random uppercase letters or digits: map resources, such as `MAP0B5FJ`.
- `TAB` plus five random uppercase letters or digits: table resources, such as `TABT946I`.
- `DOC` plus five random uppercase letters or digits: document resources.
- `RPT` plus five random uppercase letters or digits: report resources, such as `RPT5W1C0`.
- `DST` plus five random uppercase letters or digits: dataset resources.
- `SEV` plus five random uppercase letters or digits: service resources.
- `API` plus five random uppercase letters or digits: API resources.
- `ADM` plus five random uppercase letters or digits: admin resources, such as `ADMBSHVR`.

Each resource owns a separate `resource.json` metadata file under its resource subdirectory. Resource registration validates the declared ID. A resource cannot be registered when the ID is missing, uses the wrong prefix for its type, is not eight characters, or is already used by another resource. The slug-style `resource_key` remains separate so existing route, permission, featured-item, and discovery references stay stable.

### SYS_RESOURCE_PERMISSIONS

```sql
CREATE TABLE SYS_RESOURCE_PERMISSIONS (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  user_id INTEGER,
  team_id INTEGER,
  permission_level INTEGER NOT NULL CHECK (permission_level BETWEEN 1 AND 127),
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (resource_id) REFERENCES SYS_RESOURCES(resource_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (user_id) REFERENCES SYS_USERS(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES SYS_TEAMS(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES SYS_USERS(id) ON DELETE SET NULL,
  CHECK (
    (user_id IS NOT NULL AND team_id IS NULL)
    OR
    (user_id IS NULL AND team_id IS NOT NULL)
  ),
  UNIQUE (resource_id, user_id),
  UNIQUE (resource_id, team_id)
);
```

Notes:

- A permission row belongs to either one user or one team.
- A permission row stores a bitmask containing one or more permission types.
- `resource_id` stores the public 8-character resource ID from `SYS_RESOURCES.resource_id`, not the internal primary key.
- A permission row should not belong to both a user and a team.
- A permission row should not have both `user_id` and `team_id` empty.
- Team permissions are inherited through the team hierarchy.
- Direct user permissions can be used for exceptions.

### SYS_USER_FEATURED_RESOURCES

```sql
CREATE TABLE SYS_USER_FEATURED_RESOURCES (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'all' CHECK (
    category IN ('all', 'dashboard', 'map', 'tab', 'doc', 'report', 'dataset')
  ),
  resource_record_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES SYS_USERS(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_record_id) REFERENCES SYS_RESOURCES(id) ON DELETE CASCADE,
  UNIQUE (user_id, category, resource_record_id)
);
```

Notes:

- This table stores each user's pinned or featured portal resources.
- Users may only pin resources they can access.
- If a user loses access to a resource, the backend should hide it from the featured list.
- `sort_order` controls the display order on the Portal home page.
- `category` allows one featured order per Portal category.

### SYS_TEAM_FEATURED_RESOURCES

```sql
CREATE TABLE SYS_TEAM_FEATURED_RESOURCES (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'all' CHECK (
    category IN ('all', 'dashboard', 'map', 'tab', 'doc', 'report', 'dataset')
  ),
  resource_record_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES SYS_TEAMS(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_record_id) REFERENCES SYS_RESOURCES(id) ON DELETE CASCADE,
  UNIQUE (team_id, category, resource_record_id)
);
```

Notes:

- This table stores team default featured resources.
- User featured resources override team defaults; if a user has no personal configuration, load the team default.
- `category` allows admins to configure defaults per Portal category.

### SYS_PASSWORD_RESET_TOKENS

```sql
CREATE TABLE SYS_PASSWORD_RESET_TOKENS (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES SYS_USERS(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES SYS_USERS(id) ON DELETE SET NULL
);
```

Notes:

- Store only the reset token hash, never the raw reset token.
- A token is valid only when `used_at IS NULL` and `expires_at` is in the future.
- Admin password reset should set `must_change_password = 1`.
- If the reset behavior is to restore the initial password, hash the employee ID again and require change on next login.

### SYS_AUDIT_LOGS

```sql
CREATE TABLE SYS_AUDIT_LOGS (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  details_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES SYS_USERS(id) ON DELETE SET NULL
);
```

Notes:

- Use audit logs for user changes, team changes, permission changes, resource changes, public access changes, and password resets.
- `details_json` can store before/after values or action metadata.

### Recommended Indexes

```sql
CREATE INDEX idx_sys_users_team_id ON SYS_USERS(team_id);
CREATE INDEX idx_sys_users_email ON SYS_USERS(email);
CREATE INDEX idx_sys_users_employee_id ON SYS_USERS(employee_id);
CREATE INDEX idx_sys_users_admin_active ON SYS_USERS(is_admin, is_active);
CREATE INDEX idx_sys_users_deleted_at ON SYS_USERS(deleted_at);

CREATE INDEX idx_sys_teams_parent_team_id ON SYS_TEAMS(parent_team_id);
CREATE INDEX idx_sys_teams_manager_user_id ON SYS_TEAMS(manager_user_id);

CREATE INDEX idx_sys_resources_type_active ON SYS_RESOURCES(resource_type, is_active);
CREATE INDEX idx_sys_resources_public_active ON SYS_RESOURCES(is_public, is_active);

CREATE INDEX idx_sys_resource_permissions_resource_id ON SYS_RESOURCE_PERMISSIONS(resource_id);
CREATE INDEX idx_sys_resource_permissions_user_id ON SYS_RESOURCE_PERMISSIONS(user_id);
CREATE INDEX idx_sys_resource_permissions_team_id ON SYS_RESOURCE_PERMISSIONS(team_id);

CREATE INDEX idx_sys_user_featured_resources_user_order
  ON SYS_USER_FEATURED_RESOURCES(user_id, category, sort_order);
CREATE INDEX idx_sys_user_featured_resources_resource_record_id
  ON SYS_USER_FEATURED_RESOURCES(resource_record_id);

CREATE INDEX idx_sys_team_featured_resources_team_order
  ON SYS_TEAM_FEATURED_RESOURCES(team_id, category, sort_order);
CREATE INDEX idx_sys_team_featured_resources_resource_record_id
  ON SYS_TEAM_FEATURED_RESOURCES(resource_record_id);

CREATE INDEX idx_sys_password_reset_tokens_user_id ON SYS_PASSWORD_RESET_TOKENS(user_id);
CREATE INDEX idx_sys_password_reset_tokens_expires_at ON SYS_PASSWORD_RESET_TOKENS(expires_at);

CREATE INDEX idx_sys_audit_logs_actor_user_id ON SYS_AUDIT_LOGS(actor_user_id);
CREATE INDEX idx_sys_audit_logs_target ON SYS_AUDIT_LOGS(target_type, target_id);
CREATE INDEX idx_sys_audit_logs_created_at ON SYS_AUDIT_LOGS(created_at);
```

### Backend Validation Rules

The database should enforce what SQLite can enforce well. The backend should enforce cross-row business rules:

- A team cannot be moved under one of its descendants.
- A normal active user must have a team.
- A team manager should be active and assigned to the managed team.
- A user can only pin resources they can access.
- A disabled user cannot log in.
- A disabled resource cannot be opened from the catalog or featured list.
- Permission changes should always write an audit log entry.
- At least one active system admin must always exist.
- System admins cannot be deleted, soft-deleted, deactivated, or demoted through normal app workflows.
- Only system admins can promote or demote portal admins.
- Only system admins can delete or soft-delete portal admins.
- Portal admins can manage normal users, teams, resources, and permissions.
- Portal admins cannot modify protected system admin accounts.
- Portal admins cannot grant system admin access.

Audit logs should record permission changes, user changes, team changes, public access changes, and password reset actions.

## Suggested Backend APIs

User-facing APIs:

```text
GET  /api/me
GET  /api/me/resources
GET  /api/me/featured-resources
PUT  /api/me/featured-resources
POST /api/auth/change-password
```

Admin APIs:

```text
GET    /api/admin/users
POST   /api/admin/users
PATCH  /api/admin/users/{id}
DELETE /api/admin/users/{id}
PATCH  /api/admin/users/{id}/admin-status

GET    /api/admin/teams
POST   /api/admin/teams
PATCH  /api/admin/teams/{id}

GET    /api/admin/resources
POST   /api/admin/resources
PATCH  /api/admin/resources/{id}

GET    /api/admin/resources/{id}/permissions
PUT    /api/admin/resources/{id}/permissions

POST   /api/admin/users/{id}/reset-password
```

## Suggested Frontend Pages

First version:

- User list and user editor
- My profile page
- My featured resources editor
- Team tree and team editor
- User team assignment editor
- Team manager assignment editor
- Resource list and resource editor
- Resource permission editor
- Password reset action
- Public/private resource toggle
- Access-filtered portal catalog
- Personalized featured resources on the Portal home page

## Resource Launch Context

When an authenticated user opens a resource from the Portal, the Portal appends the
current identity and effective resource permissions to the resource URL. Resources
can read these query parameters in frontend or backend integration code:

```text
portal_resource_id
portal_email
portal_employeeid
portal_first_name
portal_last_name
portal_team_name
portal_is_manager
portal_user_role
portal_permission
portal_permission_level
portal_permission_types
portal_permission_source
```

`portal_permission_types` is a comma-separated list such as
`view,review,create`. `portal_permission_level` is the corresponding bitmask, and
`portal_permission_source` identifies where the effective permissions came from,
such as `team + user`. The backend remains the authority for protected operations;
resources must not treat URL parameters as a substitute for server-side permission
checks.

## Security Notes

- Never store plain text passwords.
- Use bcrypt or Argon2 for password hashing.
- Treat employee-ID initial passwords as temporary only.
- Require password change on first login after account creation or admin reset.
- Store password reset tokens as hashes.
- Expire reset tokens.
- Mark reset tokens as used after successful reset.
- Log permission changes and password reset actions.
- Keep system admin access explicit.
- Prefer allow-only access rules for the first version.

## Recommended First Version

Start with a small, useful RBAC implementation:

- Users
- Hierarchical teams
- One primary team per user
- One manager per team
- Resources
- User and team permissions for resources
- Public resource access
- User profile view
- User featured resources
- Password reset
- Audit logs
- Access-filtered resource catalog

This gives the Portal a practical management foundation without overbuilding the first release.
