// src/db/pool.js — PostgreSQL connection pool
import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let _pool = null;

export function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    _pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
  }
  return _pool;
}

export async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

export async function getClient() {
  const pool = getPool();
  return pool.connect();
}

export async function checkDb() {
  const pool = getPool();
  await pool.query('SELECT 1');
}

// Run all DB migrations / table creation on startup
export async function initDb() {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kitchen_sessions (
      kitchen_id       TEXT PRIMARY KEY,
      owner_phone      TEXT NOT NULL,
      household_size   INTEGER,
      address          TEXT,
      dietary_prefs    JSONB DEFAULT '[]'::jsonb,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      phone            TEXT PRIMARY KEY,
      kitchen_id       TEXT REFERENCES kitchen_sessions(kitchen_id),
      role             TEXT CHECK (role IN ('owner','cook','contributor')),
      display_name     TEXT,
      is_verified      BOOLEAN DEFAULT false,
      language_code    TEXT DEFAULT 'en',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recipe_overrides (
      phone            TEXT REFERENCES user_profiles(phone),
      dish_name        TEXT,
      exclusions       JSONB DEFAULT '[]'::jsonb,
      additions        JSONB DEFAULT '[]'::jsonb,
      substitutions    JSONB DEFAULT '{}'::jsonb,
      custom_notes     TEXT,
      preferred_video  TEXT,
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (phone, dish_name)
    );

    CREATE TABLE IF NOT EXISTS order_history (
      order_id         UUID PRIMARY KEY,
      kitchen_id       TEXT REFERENCES kitchen_sessions(kitchen_id),
      items            JSONB DEFAULT '[]'::jsonb,
      total            NUMERIC(10,2),
      payment_mode     TEXT DEFAULT 'COD',
      status           TEXT DEFAULT 'placed',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id               SERIAL PRIMARY KEY,
      kitchen_id       TEXT,
      event_type       TEXT,
      source_phone     TEXT,
      source_role      TEXT,
      target_phones    JSONB DEFAULT '[]'::jsonb,
      payload          JSONB DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS menu_history (
      id               SERIAL PRIMARY KEY,
      kitchen_id       TEXT REFERENCES kitchen_sessions(kitchen_id),
      menu_date        DATE DEFAULT CURRENT_DATE,
      dishes           JSONB DEFAULT '[]'::jsonb,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shelf_life_rules (
      item_category    TEXT PRIMARY KEY,
      shelf_days       INTEGER NOT NULL,
      check_after      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS youtube_video_cache (
      dish_name        TEXT,
      language         TEXT,
      video_id         TEXT,
      url              TEXT,
      title            TEXT,
      channel          TEXT,
      thumbnail        TEXT,
      expires_at       TIMESTAMPTZ,
      PRIMARY KEY (dish_name, language)
    );
  `);

  // Seed some shelf_life_rules if empty
  await pool.query(`
    INSERT INTO shelf_life_rules (item_category, shelf_days, check_after) VALUES
      ('%paneer%', 3, 2),
      ('%curd%', 3, 2),
      ('%yogurt%', 3, 2),
      ('%milk%', 2, 1),
      ('%cream%', 3, 2),
      ('%tomato%', 5, 3),
      ('%spinach%', 3, 2),
      ('%coriander%', 4, 3),
      ('%methi%', 3, 2),
      ('%chicken%', 2, 1),
      ('%fish%', 1, 1),
      ('%mutton%', 2, 1)
    ON CONFLICT (item_category) DO NOTHING;
  `);

  console.log('[DB] Tables initialized');
}
