-- Alfredo on Cloudflare: the D1 tables behind the Worker in worker.mjs.
-- Idempotent; running it again only adds what is new.
CREATE TABLE IF NOT EXISTS ws_users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor', created_at TEXT NOT NULL
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
