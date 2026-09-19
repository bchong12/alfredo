-- Alfredo on Cloudflare: the D1 tables behind the Worker in worker.mjs.
-- Idempotent; running it again only adds what is new.
CREATE TABLE IF NOT EXISTS ws_users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', password_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ws_items (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ws_tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
  assignee TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
  linked_item TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ws_items_updated ON ws_items(archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS ws_tasks_status ON ws_tasks(archived, status);

-- People, and what they may reach. The Worker is the only door to this
-- database, so these tables are what access actually means here.
CREATE TABLE IF NOT EXISTS ws_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ws_invites (
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', projects TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS ws_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'slate',
  position REAL NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ws_project_members (
  project_id TEXT NOT NULL REFERENCES ws_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'write',
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS ws_project_items (
  kind TEXT NOT NULL, item_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES ws_projects(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, item_id)
);
CREATE INDEX IF NOT EXISTS ws_project_items_project ON ws_project_items(project_id);
