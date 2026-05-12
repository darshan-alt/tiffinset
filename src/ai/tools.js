import { v4 as uuidv4 } from 'uuid';
import redis from '../db/redis.js';
import pool from '../db/pool.js';
import { sendText } from '../transport/index.js';
import { searchVideo } from '../recipe/youtube.js';
import { getOverrides, saveOverride } from '../recipe/overrides.js';
import { getKitchenMembers, logEvent } from '../kitchen/routing.js';
import { searchProduct, addToCart, viewCart, placeOrder } from '../order/swiggy.js';
import { logInfo, incrementMetric } from '../middleware/logger.js';

export const toolDefinitions = [
  {
    name: 'search_recipe',
    description: 'Search for a recipe by dish name. Returns ingredients list and cooking steps.',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string', description: 'Name of the dish in Hindi or English' },
        servings: { type: 'integer', description: 'Number of servings to scale to' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'search_youtube_video',
    description: 'Find a recipe video on YouTube. Returns URL and title.',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string' },
        language: { type: 'string', description: 'hi for Hindi, en for English' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'search_instamart',
    description: 'Search Swiggy Instamart for a grocery item. Returns brands with prices.',
    parameters: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Item to search for' },
        quantity: { type: 'string', description: 'Desired quantity e.g. 500g, 1kg, 1L' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'add_to_cart',
    description: 'Add a product to the shopping cart.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        product_name: { type: 'string' },
        price: { type: 'number' },
        quantity: { type: 'integer' },
      },
      required: ['product_id', 'product_name', 'price'],
    },
  },
  {
    name: 'view_cart',
    description: 'View the current shopping cart with items and total.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'place_order',
    description: 'Place the order. COD payment. ALWAYS show cart summary and ask for confirmation first.',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'Must be true. Only set after user explicitly confirms.' },
      },
      required: ['confirmed'],
    },
  },
  {
    name: 'get_recipe_overrides',
    description: 'Get user personal customizations for a dish (exclusions, additions, substitutions).',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'save_recipe_override',
    description: 'Save a recipe customization for the user.',
    parameters: {
      type: 'object',
      properties: {
        dish_name: { type: 'string' },
        exclusions: { type: 'array', items: { type: 'string' } },
        additions: { type: 'array', items: { type: 'string' } },
        substitutions: { type: 'object' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'get_order_history',
    description: 'Get recent grocery orders for this kitchen.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days back to look' },
      },
    },
  },
  {
    name: 'route_to_kitchen_member',
    description: 'Send a message to another kitchen member (cook or owner).',
    parameters: {
      type: 'object',
      properties: {
        target_role: { type: 'string', enum: ['owner', 'cook', 'contributor'] },
        message: { type: 'string' },
      },
      required: ['target_role', 'message'],
    },
  },
];

// ── Tool executor ───────────────────────────────────────────────────
export async function executeTool(name, args, context) {
  const { chatId, kitchenId, role } = context;

  switch (name) {
    case 'search_recipe': {
      // MVP: return a placeholder — Gemini's own knowledge will fill the recipe
      // via the text response after seeing this tool result
      return {
        dish_name: args.dish_name,
        servings: args.servings || 4,
        note: 'Recipe data will come from your own knowledge. Format it with an ingredients list (name, quantity, unit) and numbered steps.',
      };
    }

    case 'search_youtube_video': {
      const video = await searchVideo(args.dish_name, args.language || 'hi');
      if (!video) {
        return { url: null, message: 'Video nahi mila, recipe text se kaam chalao.' };
      }
      return video;
    }

    case 'search_instamart': {
      const products = await searchProduct(kitchenId, args.item_name, args.quantity);
      return { item: args.item_name, quantity: args.quantity || 'standard', options: products };
    }

    case 'add_to_cart': {
      return await addToCart(kitchenId, args.product_id, args.product_name, args.price, args.quantity);
    }

    case 'view_cart': {
      return await viewCart(kitchenId);
    }

    case 'place_order': {
      if (args.confirmed !== true) {
        return { error: 'Pehle cart dekho aur confirm karo', cart: await viewCart(kitchenId) };
      }
      const orderResult = await placeOrder(kitchenId, chatId);
      incrementMetric('ordersPlaced');
      logInfo(context, 'order_placed', { orderId: orderResult.orderId, total: orderResult.total, items: orderResult.items?.length });
      return orderResult;
    }

    case 'get_recipe_overrides': {
      const overrides = await getOverrides(chatId, args.dish_name);
      return { dish_name: args.dish_name, ...overrides };
    }

    case 'save_recipe_override': {
      return await saveOverride(chatId, args.dish_name, args);
    }

    case 'get_order_history': {
      const days = args.days || 7;
      const res = await pool.query(
        'SELECT order_id, items, total, payment_mode, status, created_at FROM order_history WHERE kitchen_id = $1 AND created_at >= NOW() - INTERVAL \'1 day\' * $2 ORDER BY created_at DESC',
        [kitchenId, days]
      );
      return { orders: res.rows };
    }

    case 'route_to_kitchen_member': {
      const targets = await getKitchenMembers(kitchenId, args.target_role);
      if (targets.length === 0) {
        return { sent: false, error: `No ${args.target_role} found in this kitchen` };
      }
      const targetPhones = [];
      for (const target of targets) {
        await sendText(target.phone, `Message from ${role}: ${args.message}`);
        targetPhones.push(target.phone);
      }
      await logEvent(kitchenId, 'route_to_kitchen_member', chatId, targetPhones, { message: args.message, target_role: args.target_role });
      return { sent: true, to: targetPhones };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
