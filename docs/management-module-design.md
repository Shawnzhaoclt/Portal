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
/dashboard_critical_team
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

Suggested permission levels:

- `view`
- `edit`
- `manage`
- `admin`

For most Portal dashboards, maps, tables, and documents, `view` will be enough.

Avoid deny rules in the first version. Allow-only permissions are easier to understand, test, and audit.

Suggested permission policy:

- Grant resource access to teams whenever possible.
- Let child teams inherit permissions from parent teams.
- Use individual permissions only when one user needs access different from their team.
- Show both assigned permission and effective permission in the management UI.
- Show where effective access comes from: public, direct user permission, team permission, inherited parent team permission, portal admin, or system admin.
- Public resources grant view access only. Edit, manage, and admin access still require explicit permission.
- Permission changes should always write an audit log entry.

## Access Decision Rule

When a user requests a resource:

1. If the resource is public, allow view access.
2. If the user is a system admin, allow all access.
3. If the request is for a management function and the user is a portal admin, allow management access, except for protected system admin actions.
4. Check permissions from the user's team.
5. Include permissions inherited from parent teams.
6. Check direct user permissions for the resource.
7. Use the highest permission level found.

If no matching permission is found, deny access.

## Suggested SQLite Tables

Core tables:

```text
users
teams
resources
resource_permissions
user_featured_resources
password_reset_tokens
audit_logs
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

Permission levels should use numeric values so the backend can easily select the highest effective permission:

```text
10 = view
20 = edit
30 = manage
40 = admin
```

### teams

```sql
CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_team_id INTEGER,
  manager_user_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_team_id) REFERENCES teams(id) ON DELETE SET NULL,
  FOREIGN KEY (manager_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (parent_team_id IS NULL OR parent_team_id <> id)
);
```

Notes:

- `parent_team_id` supports team hierarchy.
- `manager_user_id` stores the manager for the team.
- `manager_user_id` can be null during setup or data import.
- The backend should prevent descendant cycles when changing `parent_team_id`.
- The backend should normally require the manager to be an active user assigned to the same team.

### users

```sql
CREATE TABLE users (
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
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
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
CREATE TRIGGER prevent_system_admin_delete
BEFORE DELETE ON users
WHEN OLD.is_system_admin = 1
BEGIN
  SELECT RAISE(ABORT, 'system admin users cannot be deleted');
END;
```

This trigger protects system admin users if a future maintenance script or admin API attempts a hard delete. Normal application delete actions should still use soft delete by setting `deleted_at`.

### resources

```sql
CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (
    resource_type IN ('dashboard', 'map', 'tab', 'doc', 'admin', 'api')
  ),
  url TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Notes:

- `resource_key` should be a stable identifier, such as `map_stm_risk`.
- `url` is the route path, such as `/map_stm_risk`.
- Public resources do not need explicit user or team permissions for view access.
- Disabled resources should not appear in the portal catalog or featured items.

### resource_permissions

```sql
CREATE TABLE resource_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  user_id INTEGER,
  team_id INTEGER,
  permission_level INTEGER NOT NULL CHECK (permission_level IN (10, 20, 30, 40)),
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
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
- A permission row should not belong to both a user and a team.
- A permission row should not have both `user_id` and `team_id` empty.
- Team permissions are inherited through the team hierarchy.
- Direct user permissions can be used for exceptions.

### user_featured_resources

```sql
CREATE TABLE user_featured_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  resource_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  UNIQUE (user_id, resource_id)
);
```

Notes:

- This table stores each user's pinned or featured portal resources.
- Users may only pin resources they can access.
- If a user loses access to a resource, the backend should hide it from the featured list.
- `sort_order` controls the display order on the Portal home page.

### password_reset_tokens

```sql
CREATE TABLE password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
```

Notes:

- Store only the reset token hash, never the raw reset token.
- A token is valid only when `used_at IS NULL` and `expires_at` is in the future.
- Admin password reset should set `must_change_password = 1`.
- If the reset behavior is to restore the initial password, hash the employee ID again and require change on next login.

### audit_logs

```sql
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  details_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
```

Notes:

- Use audit logs for user changes, team changes, permission changes, resource changes, public access changes, and password resets.
- `details_json` can store before/after values or action metadata.

### Recommended Indexes

```sql
CREATE INDEX idx_users_team_id ON users(team_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_employee_id ON users(employee_id);
CREATE INDEX idx_users_admin_active ON users(is_admin, is_active);
CREATE INDEX idx_users_deleted_at ON users(deleted_at);

CREATE INDEX idx_teams_parent_team_id ON teams(parent_team_id);
CREATE INDEX idx_teams_manager_user_id ON teams(manager_user_id);

CREATE INDEX idx_resources_type_active ON resources(resource_type, is_active);
CREATE INDEX idx_resources_public_active ON resources(is_public, is_active);

CREATE INDEX idx_resource_permissions_resource_id ON resource_permissions(resource_id);
CREATE INDEX idx_resource_permissions_user_id ON resource_permissions(user_id);
CREATE INDEX idx_resource_permissions_team_id ON resource_permissions(team_id);

CREATE INDEX idx_user_featured_resources_user_order
  ON user_featured_resources(user_id, sort_order);

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);

CREATE INDEX idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
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
