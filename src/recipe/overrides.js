import pool from '../db/pool.js';

/**
 * Get merged recipe overrides for a user + dish.
 * Dish-specific overrides win over global ('*') ones.
 *
 * @param {string} chatId   – user identifier (Telegram numeric ID)
 * @param {string} dishName – dish to look up
 * @returns {{ exclusions: string[], additions: string[], substitutions: object, custom_notes: string|null, preferred_video: string|null }}
 */
export async function getOverrides(chatId, dishName) {
  const res = await pool.query(
    `SELECT dish_name, exclusions, additions, substitutions, custom_notes, preferred_video
     FROM recipe_overrides
     WHERE phone = $1 AND dish_name IN ($2, '*')`,
    [String(chatId), dishName]
  );

  let globalRow = null;
  let dishRow = null;

  for (const row of res.rows) {
    if (row.dish_name === '*') globalRow = row;
    else dishRow = row;
  }

  // Start with empty defaults
  const merged = {
    exclusions: [],
    additions: [],
    substitutions: {},
    custom_notes: null,
    preferred_video: null,
  };

  // Layer global overrides first
  if (globalRow) {
    merged.exclusions = Array.isArray(globalRow.exclusions) ? globalRow.exclusions : [];
    merged.additions = Array.isArray(globalRow.additions) ? globalRow.additions : [];
    merged.substitutions = globalRow.substitutions || {};
    merged.custom_notes = globalRow.custom_notes || null;
    merged.preferred_video = globalRow.preferred_video || null;
  }

  // Layer dish-specific on top (dish wins)
  if (dishRow) {
    const dishExcl = Array.isArray(dishRow.exclusions) ? dishRow.exclusions : [];
    const dishAdd = Array.isArray(dishRow.additions) ? dishRow.additions : [];
    const dishSubs = dishRow.substitutions || {};

    // Combine arrays (deduplicate)
    merged.exclusions = [...new Set([...merged.exclusions, ...dishExcl])];
    merged.additions = [...new Set([...merged.additions, ...dishAdd])];

    // Dish substitutions override global ones for the same key
    merged.substitutions = { ...merged.substitutions, ...dishSubs };

    // Dish-specific notes/video win if present
    if (dishRow.custom_notes) merged.custom_notes = dishRow.custom_notes;
    if (dishRow.preferred_video) merged.preferred_video = dishRow.preferred_video;
  }

  return merged;
}

/**
 * Save a recipe override for a user + dish.
 * On conflict, appends exclusions/additions and merges substitutions.
 *
 * @param {string} chatId   – user identifier
 * @param {string} dishName – dish name (or '*' for global)
 * @param {object} changes  – { exclusions?, additions?, substitutions?, custom_notes? }
 * @returns {{ saved: true }}
 */
export async function saveOverride(chatId, dishName, changes) {
  const exclusions = JSON.stringify(changes.exclusions || []);
  const additions = JSON.stringify(changes.additions || []);
  const substitutions = JSON.stringify(changes.substitutions || {});
  const customNotes = changes.custom_notes || null;

  await pool.query(
    `INSERT INTO recipe_overrides (phone, dish_name, exclusions, additions, substitutions, custom_notes, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, NOW())
     ON CONFLICT (phone, dish_name) DO UPDATE SET
       exclusions    = COALESCE(recipe_overrides.exclusions, '[]'::jsonb) || $3::jsonb,
       additions     = COALESCE(recipe_overrides.additions, '[]'::jsonb) || $4::jsonb,
       substitutions = recipe_overrides.substitutions || $5::jsonb,
       custom_notes  = COALESCE($6, recipe_overrides.custom_notes),
       updated_at    = NOW()`,
    [String(chatId), dishName, exclusions, additions, substitutions, customNotes]
  );

  return { saved: true };
}
