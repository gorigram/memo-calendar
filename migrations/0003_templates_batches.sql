CREATE TABLE event_batches (
  user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  claim_nonce TEXT NOT NULL,
  status TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  sync_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, batch_id)
);

CREATE TABLE event_templates (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  shortcut TEXT NOT NULL,
  title TEXT NOT NULL,
  time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  recurrence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE UNIQUE INDEX event_templates_by_user_shortcut ON event_templates(user_id, shortcut);
