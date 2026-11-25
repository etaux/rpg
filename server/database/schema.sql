-- RPG Maker MV MMO MVP schema
-- Run through: npm run migrate

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(20) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS characters (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(24) NOT NULL UNIQUE,
  class_id VARCHAR(20) NOT NULL CHECK (class_id IN ('warrior', 'mage', 'archer', 'priest')),
  appearance JSONB,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  experience INTEGER NOT NULL DEFAULT 0 CHECK (experience >= 0),
  gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
  map_id INTEGER NOT NULL DEFAULT 1 CHECK (map_id > 0),
  map_x INTEGER NOT NULL DEFAULT 10,
  map_y INTEGER NOT NULL DEFAULT 10,
  direction SMALLINT NOT NULL DEFAULT 2 CHECK (direction IN (2, 4, 6, 8)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_online_at TIMESTAMPTZ
);

-- Existing worlds receive the appearance column without recreating characters.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS appearance JSONB;

-- Persistent vitals make native out-of-battle item effects authoritative.
-- NULL marks an older/new character that has not yet received its first
-- calculated maximums; the server initializes it to full health on selection.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS current_hp INTEGER;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS current_mp INTEGER;

-- Persistent MV menu effects: states and permanent parameter growth are
-- server-owned, projected into the native actor only from inventorySnapshot.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS persistent_states JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS param_bonuses JSONB NOT NULL DEFAULT '[0,0,0,0,0,0,0,0]'::jsonb;

CREATE INDEX IF NOT EXISTS characters_user_id_idx ON characters(user_id);
CREATE INDEX IF NOT EXISTS characters_map_idx ON characters(map_id);

-- Solo quests are persistent. Group quests are intentionally live server state in this MVP;
-- persist them once permanent parties/guild campaigns are added.
CREATE TABLE IF NOT EXISTS character_quests (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  quest_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ready', 'complete')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (character_id, quest_id)
);

-- Existing v0.23 installations used only active/complete. Recreate the named
-- constraint idempotently so a goal can now become `ready` until the player
-- explicitly hands it in to the verified quest giver.
ALTER TABLE character_quests DROP CONSTRAINT IF EXISTS character_quests_status_check;
ALTER TABLE character_quests
  ADD CONSTRAINT character_quests_status_check CHECK (status IN ('active', 'ready', 'complete'));

-- Persistent inventory. Item definitions themselves are server-owned in src/content.js;
-- only the item id and quantity are stored for each character.
CREATE TABLE IF NOT EXISTS character_inventory (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_id VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (character_id, item_id)
);

CREATE TABLE IF NOT EXISTS character_equipment (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  -- Canonical MV equipment type key, e.g. etype_1 (weapon), etype_2
  -- (shield), etype_3 (body), etype_4 (accessory).
  slot VARCHAR(20) NOT NULL,
  item_id VARCHAR(64) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (character_id, slot)
);

-- v0.18.0: existing MVP saves used only weapon/armor/accessory. Remove the
-- old three-slot check. The server then upgrades each legacy row using the
-- actual MV etype of its stored item, avoiding any guessed armor category.
ALTER TABLE character_equipment DROP CONSTRAINT IF EXISTS character_equipment_slot_check;

-- Reserved persistent structures for the next guild and housing milestone.
CREATE TABLE IF NOT EXISTS guilds (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(32) NOT NULL UNIQUE,
  leader_character_id BIGINT NOT NULL REFERENCES characters(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'officer', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, character_id)
);

-- A character belongs to no more than one guild. The unique index also applies
-- to databases created by older releases.
CREATE UNIQUE INDEX IF NOT EXISTS guild_members_character_unique ON guild_members(character_id);

CREATE TABLE IF NOT EXISTS guild_stash (
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  item_id VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, item_id)
);

CREATE TABLE IF NOT EXISTS houses (
  id BIGSERIAL PRIMARY KEY,
  owner_character_id BIGINT REFERENCES characters(id) ON DELETE SET NULL,
  guild_id BIGINT REFERENCES guilds(id) ON DELETE SET NULL,
  map_id INTEGER NOT NULL,
  instance_key VARCHAR(64) NOT NULL UNIQUE,
  build_role VARCHAR(16) NOT NULL DEFAULT 'officer' CHECK (build_role IN ('leader', 'officer', 'member')),
  starter_furniture_granted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (owner_character_id IS NOT NULL OR guild_id IS NOT NULL)
);

-- Add the column for databases created before the housing build-permission module.
ALTER TABLE houses ADD COLUMN IF NOT EXISTS build_role VARCHAR(16) NOT NULL DEFAULT 'officer';
ALTER TABLE houses ADD COLUMN IF NOT EXISTS starter_furniture_granted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS house_items (
  id BIGSERIAL PRIMARY KEY,
  house_id BIGINT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  item_key VARCHAR(64) NOT NULL,
  tile_x INTEGER NOT NULL,
  tile_y INTEGER NOT NULL,
  rotation SMALLINT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS house_items_tile_unique ON house_items(house_id, tile_x, tile_y);

-- v0.21.0: fixed-price marketplace listings. Assets leave character_inventory
-- only while a row is active; purchase, cancellation and expiry use a single
-- transaction to move the exact remaining quantity.
CREATE TABLE IF NOT EXISTS auction_listings (
  id BIGSERIAL PRIMARY KEY,
  seller_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  item_id VARCHAR(64) NOT NULL,
  quantity_initial INTEGER NOT NULL CHECK (quantity_initial > 0),
  quantity_remaining INTEGER NOT NULL CHECK (quantity_remaining >= 0 AND quantity_remaining <= quantity_initial),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auction_listings_active_idx ON auction_listings(status, expires_at, unit_price, id);
CREATE INDEX IF NOT EXISTS auction_listings_seller_idx ON auction_listings(seller_character_id, created_at DESC);

-- One row per completed partial or complete purchase. It provides a persistent
-- seller/buyer history without trusting a client-side log.
CREATE TABLE IF NOT EXISTS auction_sales (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES auction_listings(id) ON DELETE RESTRICT,
  seller_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  buyer_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  item_id VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  total_price INTEGER NOT NULL CHECK (total_price > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auction_sales_seller_idx ON auction_sales(seller_character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auction_sales_buyer_idx ON auction_sales(buyer_character_id, created_at DESC);

-- v0.22.0: personal banker. Gold and items remain private to a character and
-- move only through transactions between these tables and character inventory.
CREATE TABLE IF NOT EXISTS character_banks (
  character_id BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS character_bank_inventory (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_id VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (character_id, item_id)
);

CREATE INDEX IF NOT EXISTS character_bank_inventory_character_idx ON character_bank_inventory(character_id, item_id);
