CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Add new columns to projects (SQLite doesn't support ADD COLUMN IF NOT EXISTS,
-- so we use a separate migration handled by try/catch in the runner)
ALTER TABLE projects ADD COLUMN group_id TEXT REFERENCES groups(id);
ALTER TABLE projects ADD COLUMN start_date TEXT;
ALTER TABLE projects ADD COLUMN end_date TEXT;
ALTER TABLE projects ADD COLUMN completed_at TEXT;

-- Ensure status supports our values (existing column already has 'active'/'archived')
-- Add sort_order for ordering within groups
ALTER TABLE progress ADD COLUMN sort_order INTEGER DEFAULT 0;
