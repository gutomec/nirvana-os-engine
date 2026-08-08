-- 002_memory_temporal.sql — memória cross-session com versionamento temporal.
-- supersede-never-delete: um registro nunca é apagado; quando um fato muda, um
-- novo registro é inserido e o antigo recebe superseded_by = id do novo.
-- "Ativo" = superseded_by IS NULL. Histórico preservado para auditoria/vindication.
CREATE TABLE IF NOT EXISTS memory_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug TEXT NOT NULL,
  statement     TEXT NOT NULL,
  source        TEXT,
  valid_from    TEXT NOT NULL,
  superseded_by INTEGER,
  recorded_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_records_active ON memory_records (business_slug, superseded_by);
