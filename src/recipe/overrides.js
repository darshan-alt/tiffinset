// src/recipe/overrides.js — Per-user, per-dish recipe customizations
import { query } from '../db/pool.js';
import { logError } from '../middleware/logger.js';

/**
 * Get merged recipe overrides for a user and dish.
 * Merges global ('*') overrides as base defaults, then layers dish-specific on top.
 * Returns: { exclusions[], additions[], substitutions{}, custom_notes, preferred_video }
 */
export async function getOverrides(chatId, dishName) {
  const empty = { exclusions: [], additions: [], substitutions: {}, custom_notes: null, preferred_video: null };

  try {
    const result = await query(
      `SELECT dish_name, exclusions, additions, substitutions, custom_notes, preferred_video
       FROM recipe_overrides
       WHERE phone = $1 AND dish_name = ANY($2)`,
      [chatId, [dishName.toLowerCase(), '*']]
    );

    if (result.rows.length === 0) return empty;

    const globalRow = result.rows.find((r) => r.dish_name === '*') || null;
    const dishRow = result.rows.find((r) => r.dish_name === dishName.toLowerCase()) || null;

    // Start with global defaults
    const merged = {
      exclusions: [...(globalRow?.exclusions || [])],
      additions: [...(globalRow?.additions || [])],
      substitutions: { ...(globalRow?.substitutions || {}) },
      custom_notes: globalRow?.custom_notes || null,
      preferred_video: globalRow?.preferred_video || null,
    };

    if (!dishRow) return merged;

    // Layer dish-specific on top: arrays concat+deduplicate, substitutions merge (dish wins)
    const allExclusions = [...merged.exclusions, ...(dishRow.exclusions || [])];
    merged.exclusions = [...new Set(allExclusions)];

    const allAdditions = [...merged.additions, ...(dishRow.additions || [])];
    merged.additions = [...new Set(allAdditions)];

    merged.substitutions = { ...merged.substitutions, ...(dishRow.substitutions || {}) };

    if (dishRow.custom_notes) merged.custom_notes = dishRow.custom_notes;
    if (dishRow.preferred_video) merged.preferred_video = dishRow.preferred_video;

    return merged;
  } catch (err) {
    logError('overrides', 'getOverrides_error', err, { chatId, dishName });
    return empty;
  }
}

/**
 * Save (upsert) a recipe override.
 * On conflict: JSONB arrays are appended (deduped), substitutions merged, notes/video kept if null.
 */
export async function saveOverride(chatId, dishName, changes = {}) {
  const dish = (dishName || '*').toLowerCase();

  const { exclusions = [], additions = [], substitutions = {}, custom_notes = null, preferred_video = null } = changes;

  try {
    // Fetch existing to merge
    const existing = await getOverrides(chatId, dish === '*' ? '*' : dish);

    const mergedExclusions = [...new Set([...existing.exclusions, ...exclusions])];
    const mergedAdditions = [...new Set([...existing.additions, ...additions])];
    const mergedSubstitutions = { ...existing.substitutions, ...substitutions };

    await query(
      `INSERT INTO recipe_overrides (phone, dish_name, exclusions, additions, substitutions, custom_notes, preferred_video, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (phone, dish_name) DO UPDATE
         SET exclusions = $3,
             additions = $4,
             substitutions = $5,
             custom_notes = COALESCE($6, recipe_overrides.custom_notes),
             preferred_video = COALESCE($7, recipe_overrides.preferred_video),
             updated_at = NOW()`,
      [
        chatId,
        dish,
        JSON.stringify(mergedExclusions),
        JSON.stringify(mergedAdditions),
        JSON.stringify(mergedSubstitutions),
        custom_notes,
        preferred_video,
      ]
    );

    return { saved: true, dish_name: dish };
  } catch (err) {
    logError('overrides', 'saveOverride_error', err, { chatId, dishName });
    return { saved: false, error: err.message };
  }
}
