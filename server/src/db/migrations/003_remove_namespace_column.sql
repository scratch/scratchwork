-- Migration: Remove namespace column (reverting incomplete feature)
-- Restores original (name, owner_id) uniqueness constraint

-- Drop the namespace-based index if it exists
DROP INDEX IF EXISTS idx_projects_name_namespace;

-- Restore original unique index on (name, owner_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_owner ON projects(name, owner_id);

-- Note: SQLite doesn't support DROP COLUMN directly, and since namespace has a default value,
-- existing data will continue to work. The column will be ignored by the application.
-- For a clean removal, a full table rebuild would be needed, but that's not worth the complexity.
