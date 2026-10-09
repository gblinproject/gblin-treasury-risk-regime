-- Index of the vault's Minted and AuctionFill events (src/vaultevents.mjs).
-- Apply once: npx wrangler d1 execute gblin-usage --remote --file tools/vault-events.sql
CREATE TABLE IF NOT EXISTS vault_events (
  block INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx TEXT NOT NULL,
  kind TEXT NOT NULL,
  topics TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS vault_events_kind_block ON vault_events (kind, block DESC, log_index DESC);
CREATE TABLE IF NOT EXISTS vault_index_state (
  name TEXT PRIMARY KEY,
  indexed_to INTEGER NOT NULL,
  head_seen INTEGER,
  updated_at TEXT
);
