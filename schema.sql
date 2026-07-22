-- ConversionCo Mission Control database schema
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  business_name TEXT DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'new',
  -- stages: new -> intake1_sent -> intake1_done -> intake2_sent -> intake2_done
  --         -> generating -> preview_ready -> live -> archived
  ghl_contact_id TEXT DEFAULT '',
  intake1_data TEXT DEFAULT '',   -- JSON of form 1 submission
  intake2_data TEXT DEFAULT '',   -- JSON of form 2 submission
  preview_url TEXT DEFAULT '',
  live_url TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  type TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
CREATE INDEX IF NOT EXISTS idx_clients_stage ON clients(stage);
