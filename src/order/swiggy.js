import { v4 as uuidv4 } from 'uuid';
import redis from '../db/redis.js';
import pool from '../db/pool.js';

const MOCK_PRODUCTS = {
  atta: [
    { brand: 'Aashirvaad', name: 'Aashirvaad Superior MP Atta 5kg', price: 280, weight: '5kg' },
    { brand: 'Pillsbury', name: 'Pillsbury Chakki Fresh Atta 5kg', price: 265, weight: '5kg' },
    { brand: 'Rajdhani', name: 'Rajdhani Atta 5kg', price: 240, weight: '5kg' },
  ],
  dal: [
    { brand: 'Tata Sampann', name: 'Tata Sampann Toor Dal 1kg', price: 145, weight: '1kg' },
    { brand: 'Fortune', name: 'Fortune Arhar Dal 1kg', price: 128, weight: '1kg' },
    { brand: 'Organic Tattva', name: 'Organic Tattva Toor Dal 1kg', price: 195, weight: '1kg' },
  ],
  rice: [
    { brand: 'India Gate', name: 'India Gate Basmati Rice 5kg', price: 320, weight: '5kg' },
    { brand: 'Daawat', name: 'Daawat Rozana Basmati Rice 5kg', price: 295, weight: '5kg' },
    { brand: 'Fortune', name: 'Fortune Basmati Rice 5kg', price: 270, weight: '5kg' },
  ],
  paneer: [
    { brand: 'Amul', name: 'Amul Fresh Paneer 500g', price: 165, weight: '500g' },
    { brand: 'Mother Dairy', name: 'Mother Dairy Paneer 500g', price: 155, weight: '500g' },
    { brand: 'Govardhan', name: 'Govardhan Premium Paneer 500g', price: 180, weight: '500g' },
  ],
  oil: [
    { brand: 'Fortune', name: 'Fortune Refined Sunflower Oil 1L', price: 155, weight: '1L' },
    { brand: 'Saffola Gold', name: 'Saffola Gold Blended Oil 1L', price: 185, weight: '1L' },
    { brand: 'Dhara', name: 'Dhara Refined Sunflower Oil 1L', price: 140, weight: '1L' },
  ],
  ghee: [
    { brand: 'Amul', name: 'Amul Pure Ghee 500ml', price: 290, weight: '500ml' },
    { brand: 'Patanjali', name: 'Patanjali Cow Ghee 500ml', price: 260, weight: '500ml' },
    { brand: 'Nandini', name: 'Nandini Pure Ghee 500ml', price: 275, weight: '500ml' },
  ],
  onion: [{ brand: 'Fresh', name: 'Fresh Onion 1kg', price: 35, weight: '1kg' }],
  tomato: [{ brand: 'Fresh', name: 'Fresh Tomato 1kg', price: 40, weight: '1kg' }],
  potato: [{ brand: 'Fresh', name: 'Fresh Potato 1kg', price: 25, weight: '1kg' }],
  chilli: [{ brand: 'Fresh', name: 'Fresh Green Chilli 100g', price: 15, weight: '100g' }],
  spices: [
    { brand: 'MDH', name: 'MDH Garam Masala 100g', price: 85, weight: '100g' },
    { brand: 'Everest', name: 'Everest Meat Masala 100g', price: 75, weight: '100g' },
    { brand: 'Catch', name: 'Catch Sabzi Masala 100g', price: 45, weight: '100g' },
  ]
};

export async function searchProduct(kitchenId, itemName, quantity) {
  const cacheKey = `swiggy_cache:${kitchenId}:${itemName}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const lower = itemName.toLowerCase().trim();
  const tokens = lower.split(/\s+/).filter(Boolean);
  let matched = [];
  for (const [key, products] of Object.entries(MOCK_PRODUCTS)) {
    if (tokens.includes(key) || lower === key) {
      matched = products;
      break;
    }
  }

  if (matched.length === 0) {
    matched = [
      { brand: 'Tata', name: `Tata ${itemName}`, price: 99, weight: quantity || 'standard' },
      { brand: 'Fortune', name: `Fortune ${itemName}`, price: 89, weight: quantity || 'standard' },
      { brand: 'Local', name: `Local ${itemName}`, price: 79, weight: quantity || 'standard' },
    ];
  }

  const result = matched.map(p => ({
    id: 'mock_' + uuidv4(),
    ...p,
    available: true
  }));

  await redis.setex(cacheKey, 1800, JSON.stringify(result));
  return result;
}

export async function addToCart(kitchenId, productId, productName, price, quantity = 1) {
  const cartKey = `cart:${kitchenId}`;
  const cartStr = await redis.get(cartKey);
  const cart = cartStr ? JSON.parse(cartStr) : [];
  
  cart.push({ productId, productName, price, quantity });
  
  await redis.setex(cartKey, 7200, JSON.stringify(cart));
  return { success: true, cartSize: cart.length };
}

export async function viewCart(kitchenId) {
  const cartKey = `cart:${kitchenId}`;
  const cartStr = await redis.get(cartKey);
  const items = cartStr ? JSON.parse(cartStr) : [];
  const total = items.reduce((sum, i) => sum + (i.price * (i.quantity || 1)), 0);
  
  return { 
    items, 
    total, 
    itemCount: items.length, 
    freeDeliveryMin: 199, 
    deliveryFee: total >= 199 ? 0 : 30 
  };
}

export async function placeOrder(kitchenId, ownerChatId) {
  const cartData = await viewCart(kitchenId);
  if (cartData.items.length === 0) {
    return { error: 'Cart is empty' };
  }

  const orderId = uuidv4();
  const idempotencyKey = `idempotency:${orderId}`;
  await redis.setex(idempotencyKey, 300, 'processing');

  await pool.query(
    'INSERT INTO order_history (order_id, kitchen_id, items, total, payment_mode, status) VALUES ($1, $2, $3, $4, $5, $6)',
    [orderId, kitchenId, JSON.stringify(cartData.items), cartData.total + cartData.deliveryFee, 'COD', 'placed']
  );

  await redis.del(`cart:${kitchenId}`);

  return { 
    orderId, 
    items: cartData.items, 
    total: cartData.total + cartData.deliveryFee, 
    deliveryFee: cartData.deliveryFee, 
    eta: '15-20 minutes', 
    payment: 'Cash on Delivery' 
  };
}
