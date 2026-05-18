// src/ai/tools.js — Gemini function declarations + tool executor
import { getRedis } from '../db/redis.js';
import { query } from '../db/pool.js';
import { searchVideo } from '../recipe/youtube.js';
import { getOverrides, saveOverride } from '../recipe/overrides.js';
import { searchProduct, addToCart, viewCart, placeOrder } from '../order/swiggy.js';
import { getKitchenMembers, routeEvent } from '../kitchen/routing.js';
import { sendText } from '../transport/index.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Tool Definitions (Gemini functionDeclarations format) ───────────────────

export const toolDefinitions = [
  {
    name: 'search_recipe',
    description: 'Get a recipe for a dish. Use your own knowledge to provide ingredients and step-by-step cooking instructions. Apply any user recipe overrides.',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string', description: 'Name of the dish to get recipe for' },
        servings: { type: 'integer', description: 'Number of servings (optional, defaults to household size)' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'search_youtube_video',
    description: 'Search for a YouTube cooking video for a dish. Returns video URL, title, and channel.',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string', description: 'Name of the dish' },
        language: { type: 'string', description: 'Language preference: hi (Hindi) or en (English)', enum: ['hi', 'en'] },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'search_instamart',
    description: 'Search for grocery products on Swiggy Instamart. Returns 3 Indian brand options with prices in INR.',
    parameters: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Name of the grocery item to search for' },
        quantity: { type: 'string', description: 'Quantity needed (optional, e.g. "2kg", "500g")' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'add_to_cart',
    description: 'Add a grocery product to the kitchen cart.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product ID from search results' },
        product_name: { type: 'string', description: 'Name of the product' },
        price: { type: 'number', description: 'Price per unit in INR' },
        quantity: { type: 'integer', description: 'Number of units to add (default: 1)' },
      },
      required: ['product_id', 'product_name', 'price'],
    },
  },
  {
    name: 'view_cart',
    description: 'View current cart contents, total amount, and delivery fee.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'place_order',
    description: 'Place the grocery order. IMPORTANT: You MUST ask the user to confirm BEFORE calling this with confirmed=true. Never auto-place.',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'Must be true — user has explicitly confirmed the order' },
      },
      required: ['confirmed'],
    },
  },
  {
    name: 'get_recipe_overrides',
    description: 'Get personal recipe customizations for a dish (ingredients to exclude, add, or substitute).',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string', description: 'Name of the dish' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'save_recipe_override',
    description: 'Save a recipe customization for a dish (e.g., "no onion in dal", "extra ginger in chai").',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string', description: 'Name of the dish, or "*" for global default' },
        exclusions: { type: 'array', items: { type: 'string' }, description: 'Ingredients to remove' },
        additions: { type: 'array', items: { type: 'string' }, description: 'Ingredients to add' },
        substitutions: { type: 'object', description: 'Ingredient substitutions map: {original: replacement}' },
        custom_notes: { type: 'string', description: 'Any other cooking notes' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'get_order_history',
    description: 'Get past grocery orders for the kitchen.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Number of past days to fetch (default: 30)' },
      },
      required: [],
    },
  },
  {
    name: 'route_to_kitchen_member',
    description: 'Send a message to another kitchen member by role (cook, contributor, or owner). Use this to notify cooks of the daily menu, report shortages to the owner, or forward dish suggestions.',
    parameters: {
      type: 'object',
      properties: {
        target_role: { type: 'string', description: 'Role to send to: cook, contributor, or owner', enum: ['cook', 'contributor', 'owner'] },
        message: { type: 'string', description: 'Message to send to the kitchen member(s)' },
      },
      required: ['target_role', 'message'],
    },
  },
];

// ─── Role-based tool filtering ────────────────────────────────────────────────

const COOK_BLOCKED_TOOLS = new Set(['search_instamart', 'add_to_cart', 'view_cart', 'place_order', 'get_order_history', 'save_recipe_override']);
const CONTRIBUTOR_BLOCKED_TOOLS = new Set(['search_instamart', 'add_to_cart', 'view_cart', 'place_order', 'save_recipe_override']);

export function getToolsForRole(role) {
  const blocked = role === 'cook' ? COOK_BLOCKED_TOOLS : role === 'contributor' ? CONTRIBUTOR_BLOCKED_TOOLS : new Set();
  return toolDefinitions.filter((t) => !blocked.has(t.name));
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

/**
 * Execute a tool call from Gemini.
 * context: { chatId, kitchenId, role }
 */
export async function executeTool(name, args, context) {
  const { chatId, kitchenId } = context;

  try {
    switch (name) {
      case 'search_recipe':
        return _searchRecipe(args.dish_name, args.servings, chatId);

      case 'search_youtube_video':
        return _searchYoutubeVideo(args.dish_name, args.language || 'hi');

      case 'search_instamart':
        return searchProduct(kitchenId, args.item_name, args.quantity);

      case 'add_to_cart':
        return addToCart(kitchenId, {
          product_id: args.product_id,
          product_name: args.product_name,
          price: args.price,
          quantity: args.quantity || 1,
        });

      case 'view_cart':
        return viewCart(kitchenId);

      case 'place_order':
        return placeOrder(kitchenId, chatId, args.confirmed);

      case 'get_recipe_overrides':
        return getOverrides(chatId, args.dish_name);

      case 'save_recipe_override':
        return saveOverride(chatId, args.dish_name, {
          exclusions: args.exclusions,
          additions: args.additions,
          substitutions: args.substitutions,
          custom_notes: args.custom_notes,
        });

      case 'get_order_history':
        return _getOrderHistory(kitchenId, args.days || 30);

      case 'route_to_kitchen_member':
        return _routeToKitchenMember(kitchenId, chatId, context.role, args.target_role, args.message);

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`[Tools] Error executing ${name}:`, err.message);
    return { error: err.message };
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function _searchRecipe(dishName, servings, chatId) {
  // Get overrides first to include in the prompt context
  let overridesNote = '';
  try {
    const overrides = await getOverrides(chatId, dishName);
    const parts = [];
    if (overrides.exclusions?.length) parts.push(`Exclude: ${overrides.exclusions.join(', ')}`);
    if (overrides.additions?.length) parts.push(`Add: ${overrides.additions.join(', ')}`);
    if (overrides.substitutions && Object.keys(overrides.substitutions).length) {
      const subs = Object.entries(overrides.substitutions).map(([k, v]) => `${k} → ${v}`).join(', ');
      parts.push(`Substitute: ${subs}`);
    }
    if (overrides.custom_notes) parts.push(`Note: ${overrides.custom_notes}`);
    if (parts.length) overridesNote = `User preferences: ${parts.join('; ')}`;
  } catch (err) {
    // Ignore overrides fetch error
  }

  return {
    instruction: `Use your own knowledge to provide a complete recipe for ${dishName}${servings ? ` for ${servings} servings` : ''}.
Include: ingredients list with quantities, step-by-step cooking instructions, cooking time, and difficulty level.
${overridesNote}
Apply the user preferences above to the recipe.`,
  };
}

async function _searchYoutubeVideo(dishName, language) {
  const video = await searchVideo(dishName, language || 'hi');
  if (!video) {
    return { found: false, message: 'Video not available right now.' };
  }
  return {
    found: true,
    url: video.url,
    title: video.title,
    channel: video.channel,
    thumbnail: video.thumbnail,
  };
}

async function _getOrderHistory(kitchenId, days) {
  const result = await query(
    `SELECT order_id, items, total, status, payment_mode, created_at
     FROM order_history
     WHERE kitchen_id = $1 AND created_at >= NOW() - INTERVAL '${parseInt(days, 10)} days'
     ORDER BY created_at DESC
     LIMIT 20`,
    [kitchenId]
  );
  return { orders: result.rows };
}

async function _routeToKitchenMember(kitchenId, sourcePhone, sourceRole, targetRole, message) {
  const members = await getKitchenMembers(kitchenId, targetRole);
  if (members.length === 0) {
    return { sent: false, reason: `No ${targetRole} found in this kitchen` };
  }

  for (const member of members) {
    await sendText(member.phone, message);
  }

  return { sent: true, recipients: members.length, role: targetRole };
}
