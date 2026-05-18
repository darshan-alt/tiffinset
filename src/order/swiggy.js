// src/order/swiggy.js — Mock Swiggy Instamart with realistic Indian brand data
import { getRedis } from '../db/redis.js';
import { query } from '../db/pool.js';
import { v4 as uuidv4 } from 'uuid';
import { logInfo, logError, incrementMetric } from '../middleware/logger.js';

const CART_TTL = 2 * 60 * 60;       // 2 hours
const CACHE_TTL = 30 * 60;           // 30 minutes
const FREE_DELIVERY_THRESHOLD = 199;
const DELIVERY_FEE = 30;

// ─── Mock product database (realistic 2026 INR prices) ──────────────────────

const MOCK_PRODUCTS = {
  atta: [
    { brand: 'Aashirvaad', quantity: '5kg', price: 280 },
    { brand: 'Pillsbury', quantity: '5kg', price: 265 },
    { brand: 'Rajdhani', quantity: '5kg', price: 240 },
  ],
  flour: [
    { brand: 'Aashirvaad', quantity: '5kg', price: 280 },
    { brand: 'Pillsbury', quantity: '5kg', price: 265 },
    { brand: 'Rajdhani', quantity: '5kg', price: 240 },
  ],
  dal: [
    { brand: 'Tata Sampann', quantity: '1kg', price: 145 },
    { brand: 'Fortune', quantity: '1kg', price: 128 },
    { brand: 'Organic Tattva', quantity: '1kg', price: 195 },
  ],
  lentils: [
    { brand: 'Tata Sampann', quantity: '1kg', price: 145 },
    { brand: 'Fortune', quantity: '1kg', price: 128 },
    { brand: 'Organic Tattva', quantity: '1kg', price: 195 },
  ],
  rice: [
    { brand: 'India Gate', quantity: '5kg', price: 320 },
    { brand: 'Daawat', quantity: '5kg', price: 295 },
    { brand: 'Fortune', quantity: '5kg', price: 270 },
  ],
  paneer: [
    { brand: 'Amul', quantity: '500g', price: 165 },
    { brand: 'Mother Dairy', quantity: '500g', price: 155 },
    { brand: 'Govardhan', quantity: '500g', price: 180 },
  ],
  oil: [
    { brand: 'Fortune', quantity: '1L', price: 155 },
    { brand: 'Saffola Gold', quantity: '1L', price: 185 },
    { brand: 'Dhara', quantity: '1L', price: 140 },
  ],
  'cooking oil': [
    { brand: 'Fortune', quantity: '1L', price: 155 },
    { brand: 'Saffola Gold', quantity: '1L', price: 185 },
    { brand: 'Dhara', quantity: '1L', price: 140 },
  ],
  ghee: [
    { brand: 'Amul', quantity: '500ml', price: 290 },
    { brand: 'Patanjali', quantity: '500ml', price: 260 },
    { brand: 'Nandini', quantity: '500ml', price: 275 },
  ],
  spices: [
    { brand: 'MDH', quantity: '100g', price: 85 },
    { brand: 'Everest', quantity: '100g', price: 75 },
    { brand: 'Catch', quantity: '100g', price: 45 },
  ],
  masala: [
    { brand: 'MDH', quantity: '100g', price: 85 },
    { brand: 'Everest', quantity: '100g', price: 75 },
    { brand: 'Catch', quantity: '100g', price: 45 },
  ],
  salt: [
    { brand: 'Tata Salt', quantity: '1kg', price: 28 },
    { brand: 'Catch', quantity: '1kg', price: 25 },
    { brand: 'Aashirvaad', quantity: '1kg', price: 30 },
  ],
  sugar: [
    { brand: 'Madhur', quantity: '1kg', price: 48 },
    { brand: 'Nature Fresh', quantity: '1kg', price: 52 },
    { brand: 'Double Refined', quantity: '1kg', price: 45 },
  ],
  milk: [
    { brand: 'Amul Gold', quantity: '1L', price: 66 },
    { brand: 'Mother Dairy', quantity: '1L', price: 64 },
    { brand: 'Nandini', quantity: '1L', price: 60 },
  ],
  butter: [
    { brand: 'Amul', quantity: '500g', price: 260 },
    { brand: 'Britannia', quantity: '500g', price: 275 },
    { brand: 'Mother Dairy', quantity: '500g', price: 255 },
  ],
  onion: [
    { brand: 'Fresh Onion', quantity: '1kg', price: 35 },
    { brand: 'Organic Onion', quantity: '1kg', price: 55 },
    { brand: 'Premium Onion', quantity: '1kg', price: 42 },
  ],
  tomato: [
    { brand: 'Fresh Tomato', quantity: '500g', price: 20 },
    { brand: 'Organic Tomato', quantity: '500g', price: 35 },
    { brand: 'Premium Tomato', quantity: '500g', price: 25 },
  ],
  potato: [
    { brand: 'Fresh Potato', quantity: '1kg', price: 25 },
    { brand: 'Organic Potato', quantity: '1kg', price: 40 },
    { brand: 'Premium Potato', quantity: '1kg', price: 30 },
  ],
  tea: [
    { brand: 'Tata Tea Gold', quantity: '500g', price: 145 },
    { brand: 'Brooke Bond', quantity: '500g', price: 135 },
    { brand: 'Wagh Bakri', quantity: '500g', price: 155 },
  ],
  coffee: [
    { brand: 'Nescafe Classic', quantity: '200g', price: 295 },
    { brand: 'Bru Gold', quantity: '200g', price: 275 },
    { brand: 'Continental', quantity: '200g', price: 310 },
  ],
  'curd': [
    { brand: 'Amul', quantity: '400g', price: 48 },
    { brand: 'Mother Dairy', quantity: '400g', price: 45 },
    { brand: 'Epigamia', quantity: '400g', price: 65 },
  ],
  yogurt: [
    { brand: 'Amul', quantity: '400g', price: 48 },
    { brand: 'Mother Dairy', quantity: '400g', price: 45 },
    { brand: 'Epigamia', quantity: '400g', price: 65 },
  ],
};

/**
 * Find best matching product category for a search term.
 */
function findCategory(itemName) {
  const normalized = itemName.toLowerCase().trim();
  // Direct match
  if (MOCK_PRODUCTS[normalized]) return normalized;
  // Partial match
  for (const key of Object.keys(MOCK_PRODUCTS)) {
    if (normalized.includes(key) || key.includes(normalized)) return key;
  }
  return null;
}

/**
 * Search for grocery products. Returns 3 brands with INR prices.
 * Cached per kitchen in Redis for 30 minutes.
 */
export async function searchProduct(kitchenId, itemName, quantityHint = null) {
  const cacheKey = `swiggy_cache:${kitchenId}:${itemName.toLowerCase().trim()}`;

  try {
    const redis = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    // Ignore Redis read error
  }

  const category = findCategory(itemName);
  let products;

  if (category) {
    products = MOCK_PRODUCTS[category].map((p) => ({
      product_id: uuidv4(),
      product_name: `${p.brand} ${itemName} ${p.quantity}`,
      brand: p.brand,
      quantity: p.quantity,
      price: p.price,
      in_stock: true,
    }));
  } else {
    // Generic fallback for unknown items
    products = [
      { product_id: uuidv4(), product_name: `${itemName} (Standard)`, brand: 'Generic', quantity: '1 unit', price: 50, in_stock: true },
      { product_id: uuidv4(), product_name: `${itemName} (Premium)`, brand: 'Premium', quantity: '1 unit', price: 75, in_stock: true },
      { product_id: uuidv4(), product_name: `${itemName} (Budget)`, brand: 'Budget', quantity: '1 unit', price: 35, in_stock: true },
    ];
  }

  const result = { products, item: itemName, category };

  try {
    const redis = getRedis();
    await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
  } catch (err) {
    // Ignore Redis write error
  }

  return result;
}

/**
 * Add an item to the kitchen cart (Redis).
 */
export async function addToCart(kitchenId, item) {
  const redis = getRedis();
  const cartKey = `cart:${kitchenId}`;

  const raw = await redis.get(cartKey);
  const cart = raw ? JSON.parse(raw) : [];

  // Check if already in cart — update quantity
  const existingIdx = cart.findIndex((c) => c.product_id === item.product_id);
  if (existingIdx >= 0) {
    cart[existingIdx].quantity += (item.quantity || 1);
  } else {
    cart.push({
      product_id: item.product_id,
      product_name: item.product_name,
      price: item.price,
      quantity: item.quantity || 1,
    });
  }

  await redis.set(cartKey, JSON.stringify(cart), 'EX', CART_TTL);

  const total = cart.reduce((sum, c) => sum + c.price * c.quantity, 0);
  const deliveryFee = total < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;

  return { added: true, cartItems: cart.length, total, deliveryFee };
}

/**
 * View current cart contents.
 */
export async function viewCart(kitchenId) {
  const redis = getRedis();
  const cartKey = `cart:${kitchenId}`;
  const raw = await redis.get(cartKey);
  const cart = raw ? JSON.parse(raw) : [];

  const total = cart.reduce((sum, c) => sum + c.price * c.quantity, 0);
  const deliveryFee = total < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;

  return {
    items: cart,
    total,
    deliveryFee,
    grandTotal: total + deliveryFee,
    freeDeliveryAt: FREE_DELIVERY_THRESHOLD,
  };
}

/**
 * Place an order from the cart.
 * Requires confirmed=true — Gemini must ask the user first.
 */
export async function placeOrder(kitchenId, chatId, confirmed) {
  if (!confirmed) {
    const cart = await viewCart(kitchenId);
    return {
      requiresConfirmation: true,
      message: 'Order confirm karna hai? Cart summary dekho aur "haan" bolo.',
      ...cart,
    };
  }

  const redis = getRedis();
  const cartKey = `cart:${kitchenId}`;
  const raw = await redis.get(cartKey);
  const cart = raw ? JSON.parse(raw) : [];

  if (cart.length === 0) {
    return { placed: false, reason: 'Cart empty hai. Pehle kuch add karo.' };
  }

  const total = cart.reduce((sum, c) => sum + c.price * c.quantity, 0);
  const deliveryFee = total < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;
  const orderId = uuidv4();

  // Idempotency check
  const idempKey = `idempotency:${orderId}`;
  const idempResult = await redis.set(idempKey, '1', 'EX', 300, 'NX');
  if (!idempResult) {
    return { placed: false, reason: 'Order already being processed' };
  }

  try {
    await query(
      `INSERT INTO order_history (order_id, kitchen_id, items, total, payment_mode, status)
       VALUES ($1, $2, $3, $4, 'COD', 'placed')`,
      [orderId, kitchenId, JSON.stringify(cart), total + deliveryFee]
    );

    // Clear cart
    await redis.del(cartKey);

    incrementMetric('ordersPlaced').catch(() => {});
    logInfo('swiggy', 'order_placed', { orderId, kitchenId, total, items: cart.length });

    return {
      placed: true,
      orderId,
      items: cart,
      total,
      deliveryFee,
      grandTotal: total + deliveryFee,
      eta: '15-20 minutes',
      paymentMode: 'Cash on Delivery',
    };
  } catch (err) {
    logError('swiggy', 'place_order_error', err, { kitchenId });
    return { placed: false, error: err.message };
  }
}
