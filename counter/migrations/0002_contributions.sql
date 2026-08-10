CREATE TABLE IF NOT EXISTS contributions (
  receipt TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  map_name TEXT NOT NULL,
  x_handle TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  consent_version TEXT NOT NULL,
  sample_sha TEXT NOT NULL,
  sampled_words INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  packet_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS contributions_status_created
  ON contributions (status, created_at);

CREATE TABLE IF NOT EXISTS contribution_rate (
  day TEXT NOT NULL,
  address_hash TEXT NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, address_hash)
);
