# TiffinSet — Manual Test Plan

> **Bot**: @TiffinSetBot on Telegram  
> **API**: `https://api.tiffinset.com`  
> **Date**: 2026-05-12  

---

## Pre-requisites

| Dependency | How to verify |
|---|---|
| PostgreSQL running | `curl api.tiffinset.com/health` → `db: "up"` |
| Redis running | `curl api.tiffinset.com/health` → `redis: "up"` |
| Telegram webhook set | Bot responds to `/start` |
| GCP secrets loaded | Server starts without `secret_not_found` errors |
| YouTube API key valid | Check quota at GCP console |

---

## Module 1 — Infrastructure & Health

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 1.1 | Health endpoint | `GET /health` | `200 { status: "ok", db: "up", redis: "up" }` |
| 1.2 | Health with DB down | Stop PostgreSQL, `GET /health` | `500` with error message |
| 1.3 | Health with Redis down | Stop Redis, `GET /health` | `500` with error message |
| 1.4 | Metrics endpoint | `GET /metrics` | `200` with JSON counters (`messagesReceived`, `messagesSent`, etc.) |

---

## Module 2 — Webhook & Transport Layer

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 2.1 | Valid webhook auth | POST `/webhook/telegram` with correct `x-telegram-bot-api-secret-token` header | `200 OK` |
| 2.2 | Invalid webhook auth | POST without header or wrong token | `403 Unauthorized` |
| 2.3 | Parse text message | Send a text message to bot in Telegram | `parseIncoming` returns `type: "message"` with `text` field |
| 2.4 | Parse voice message | Send a voice note to bot | `parseIncoming` returns `audio` field populated |
| 2.5 | Parse callback query | Tap an inline button | `parseIncoming` returns `type: "callback_query"` with `data` |
| 2.6 | Rate limit (20/min) | Send 21+ messages within 60 seconds from same chat | 21st message returns `429 Too Many Requests` |
| 2.7 | Dedup | Replay the same `message_id` within 5 minutes | Second request returns `200 Duplicate`, no processing |
| 2.8 | Empty/malformed body | POST with `{}` | `200 OK`, no crash, no processing |

---

## Module 3 — OTP & Authentication

### 3A — OTP Generation & Verification

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 3.1 | Generate OTP | New user sends any message | Bot replies with 6-digit OTP code |
| 3.2 | Correct OTP | Enter the exact code received | `verifyOTP` returns `{ valid: true }` |
| 3.3 | Wrong OTP (1st attempt) | Enter wrong code | Bot says "Galat code. 2 tries baaki." |
| 3.4 | Wrong OTP (3rd attempt) | Enter wrong code 3 times | Bot says "15 min baad try karo", 15-min cooldown set |
| 3.5 | OTP expiry (5 min) | Wait 5+ minutes, then enter correct code | Bot says "Code expired", new OTP sent |
| 3.6 | Cooldown enforcement | Try to generate OTP during 15-min cooldown | Bot says "Please wait X minutes" |

### 3B — Session Management

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 3.7 | Session creation | Complete onboarding | `session:{chatId}` key exists in Redis with 30-day TTL |
| 3.8 | Session refresh | Send a message as authenticated user | `lastActive` timestamp updates |
| 3.9 | Session expiry (30 days) | Manually set `lastActive` to 31 days ago in Redis, send message | Bot triggers re-auth OTP flow |
| 3.10 | Re-auth OTP verify | Enter correct re-auth OTP | Bot says "Verified! Ab baat karo." |

---

## Module 4 — Onboarding Flow (New Owner)

> **Precondition**: Use a Telegram account that has never interacted with the bot, or clear `onboarding:`, `session:`, and `user_profiles` rows for the chatId.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 4.1 | Step 1: OTP sent | Send any message (e.g. "hi") | Bot sends welcome + OTP code |
| 4.2 | Step 2: OTP verified | Enter OTP code | Bot asks "Ghar mein kitne log hain?" |
| 4.3 | Step 3: Household size | Reply "4" | Bot asks "Delivery address kya hai?" |
| 4.4 | Step 3 (non-numeric) | Reply "four" | Defaults to 4, proceeds to address |
| 4.5 | Step 4: Address | Reply "B-12, Koramangala, Bengaluru" | Bot asks about food restrictions |
| 4.6 | Step 5: Dietary (with prefs) | Reply "vegetarian, no onion" | Setup complete; DB has prefs `["vegetarian","no onion"]` |
| 4.7 | Step 5: Dietary (none) | Reply "nahi" | Setup complete; DB has prefs `[]` |
| 4.8 | DB verification | Check `kitchen_sessions` and `user_profiles` | Kitchen created with correct `owner_phone`, `address`, `household_size`, `dietary_prefs`. User profile has `role = 'owner'`. |
| 4.9 | Post-onboarding message | Send "aaj kya banau?" | Routed to AI processor (not onboarding) |

---

## Module 5 — Invitation Flow (Cook / Contributor)

> **Precondition**: Owner is fully onboarded. Have a second Telegram account (invitee).

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 5.1 | Invite cook | Owner tells bot to invite cook (triggers `handleInvitation`) | Invitee receives OTP via bot DM |
| 5.2 | Cook verifies OTP | Invitee enters correct code | Bot asks preferred language |
| 5.3 | Cook selects language | Reply "Hindi" | Cook profile created with `role=cook`, `language_code=hi`. Owner gets "Cook ne join kar liya hai." |
| 5.4 | Invite contributor | Owner invites contributor | Invitee gets OTP |
| 5.5 | Contributor verifies | Enter correct OTP | Contributor profile created. Owner notified. |
| 5.6 | Invite existing user | Invite someone already in DB | Owner sees "Yeh user pehle se TiffinSet par hai." |

---

## Module 6 — Voice Notes (Whisper STT)

> **Precondition**: User is authenticated.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 6.1 | Hindi voice note | Record "aaj paneer banana hai" and send | Bot transcribes and responds with recipe/relevant answer |
| 6.2 | English voice note | Record "what should I cook today" | Transcription works, AI responds |
| 6.3 | Noisy/unclear audio | Send garbled audio | Bot says "Sorry, main aapki voice note nahi samajh paaya. Phir se try karo?" |
| 6.4 | Long voice note (>30s) | Send a 45-second voice clip | Transcription completes, response returned |

---

## Module 7 — AI Agentic Loop (Gemini)

> **Precondition**: User is authenticated as **owner**.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 7.1 | Simple text response | "Hello" | Bot replies in Hinglish, no tool call |
| 7.2 | Recipe search trigger | "Paneer butter masala ka recipe batao" | AI calls `search_recipe` tool, returns formatted recipe |
| 7.3 | YouTube video trigger | "Paneer butter masala ka video dikhao" | AI calls `search_youtube_video`, returns YouTube link |
| 7.4 | Multi-tool chaining | "Aaj dal makhani banani hai, recipe aur video dono bhejo" | AI calls `search_recipe` + `search_youtube_video` across loop iterations |
| 7.5 | Conversation history | Ask follow-up "Isme kitna butter lagega?" after 7.2 | AI uses history context to answer about the same recipe |
| 7.6 | History TTL (24h) | Wait 24h+ or flush `chat:{chatId}` key, then ask follow-up | Bot doesn't remember prior context |
| 7.7 | Loop exhaustion | Trigger a scenario that causes 5+ tool calls | Bot returns "Processing mein thoda time lag raha hai" |
| 7.8 | Error handling | Cause `processMessage` to fail (e.g. corrupt profile) | Bot says "Kuch gadbad ho gayi. Thodi der mein try karo." |

### 7B — Role-based Tool Filtering

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 7.9 | Owner: all tools | Owner asks to search Instamart | Works — `search_instamart` available |
| 7.10 | Cook: no commerce | Cook asks to order groceries | AI cannot call `search_instamart`, `add_to_cart`, `view_cart`, `place_order`, `get_order_history` |
| 7.11 | Cook: recipe tools | Cook asks for recipe/video | Works — `search_recipe`, `search_youtube_video` available |
| 7.12 | Contributor: no save override | Contributor tries to set recipe prefs | `save_recipe_override` not available |

---

## Module 8 — Recipe Overrides

> **Precondition**: Authenticated owner.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 8.1 | Save exclusion | "Dal makhani mein cream mat daalna" | `save_recipe_override` called; DB row for (chatId, "dal makhani") with exclusions `["cream"]` |
| 8.2 | Save substitution | "Ghee ki jagah butter use karo" | DB has substitutions `{"ghee": "butter"}` |
| 8.3 | Get overrides | "Meri dal makhani preferences kya hain?" | Returns merged exclusions + substitutions |
| 8.4 | Global override | "Mujhe har dish mein onion nahi chahiye" | DB row with `dish_name = '*'`, exclusions `["onion"]` |
| 8.5 | Merge global + dish | Set global "no onion" + dish-specific "no cream" for dal | `getOverrides("dal makhani")` returns both exclusions merged |

---

## Module 9 — YouTube Video Search & Caching

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 9.1 | Fresh search (API hit) | Clear Redis + PG cache, ask for a video | YouTube API called; result cached in both Redis (48h) and PG |
| 9.2 | Redis cache hit | Ask for same video again within 48h | No API call; served from Redis |
| 9.3 | PG cache hit | Flush Redis key, ask again | Served from PG; Redis backfilled |
| 9.4 | API quota exceeded | Exhaust YouTube quota or mock 403 | Bot returns null; no crash |
| 9.5 | No results | Search for an obscure/nonexistent dish | Bot says "Video nahi mila, recipe text se kaam chalao" |

---

## Module 10 — Shopping Cart & Orders (Mock Swiggy)

> **Precondition**: Authenticated owner.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 10.1 | Search product | "Atta order karna hai" | AI calls `search_instamart`; shows 3 brand options (Aashirvaad, Pillsbury, Rajdhani) |
| 10.2 | Add to cart | Select a product | `add_to_cart` returns `{ success: true, cartSize: 1 }` |
| 10.3 | View cart | "Cart dikhao" | Shows items, total, delivery fee info |
| 10.4 | Free delivery threshold | Cart total < ₹199 | `deliveryFee: 30` shown |
| 10.5 | Free delivery achieved | Cart total ≥ ₹199 | `deliveryFee: 0` shown |
| 10.6 | Place order (confirmed) | Confirm order | `placeOrder` creates `order_history` row; cart cleared; returns orderId + ETA |
| 10.7 | Place order (unconfirmed) | AI calls `place_order` with `confirmed: false` | Returns error "Pehle cart dekho aur confirm karo" |
| 10.8 | Place empty cart | Try to order with nothing in cart | Returns `{ error: "Cart is empty" }` |
| 10.9 | Unknown product search | Search "saffron" (not in mock data) | Returns generic fallback options (Tata, Fortune, Local) |
| 10.10 | Product cache | Search same item twice within 30 min | Second call served from Redis cache |

---

## Module 11 — Smart Top-Up Suggestions

> **Precondition**: Kitchen has 2+ past orders for the same item with known reorder cycles.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 11.1 | Suggestion triggered | Cart total < ₹199, item due for reorder (score > 0.8) | `suggestTopUp` returns suggestions with item names + avg price |
| 11.2 | No suggestion needed | Cart total ≥ ₹199 | Returns `null` |
| 11.3 | No reorder history | New kitchen with < 2 orders | Returns `null` |

---

## Module 12 — Kitchen Routing & Events

> **Precondition**: Kitchen has owner + cook + contributor profiles.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 12.1 | Route to cook | Owner tells AI to message cook | `route_to_kitchen_member` sends message to cook's chatId |
| 12.2 | Route to owner | Cook reports shortage | Owner receives the message |
| 12.3 | No target found | Route to role with no members | Returns `{ sent: false, error: "No cook found in this kitchen" }` |
| 12.4 | Event logged | Any routed event | Row inserted in `event_log` with correct `event_type`, `source_phone`, `target_phones`, `payload` |
| 12.5 | Menu set event | `routeEvent({ type: 'menu_set', ... })` | Cooks get recipe + video; Contributors get summary |
| 12.6 | Shortage report event | `routeEvent({ type: 'shortage_report', ... })` | Owners get shortage details |
| 12.7 | Order confirmed event | `routeEvent({ type: 'order_confirmed', ... })` | Cooks get item list + ETA |

---

## Module 13 — Scheduled Jobs (Cron)

> **Precondition**: Orders exist in `order_history`; `shelf_life_rules` table has relevant entries.

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 13.1 | Leftover check-in (8 AM IST) | Insert an order with perishable item aged past `check_after` days | Cook receives "X din pehle Y order kiya tha. Abhi bacha hai ya khatam ho gaya?" |
| 13.2 | Reorder nudge (9 AM IST) | Item with avg reorder cycle of 7 days, last ordered 6+ days ago | Owner receives "X khatam hone wala hai. Order kar doon?" |
| 13.3 | No items due | All items recently ordered | No messages sent |

---

## Module 14 — Order History

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 14.1 | Get recent orders | Owner asks "pichle hafte ke orders dikhao" | AI calls `get_order_history` with `days: 7`; returns order list |
| 14.2 | No orders | New kitchen with no history | Returns `{ orders: [] }` |

---

## Module 15 — Edge Cases & Error Handling

| # | Test Case | Steps | Expected |
|---|---|---|---|
| 15.1 | Concurrent messages | Send 5 messages in rapid succession | All processed without race conditions; dedup catches duplicates |
| 15.2 | Empty text after parse | Send a photo (no text, no audio) | `textInput` is empty; processing skipped gracefully |
| 15.3 | DB connection failure | Kill PG mid-request | Error logged; user gets friendly error message |
| 15.4 | Redis connection failure | Kill Redis mid-request | Error logged; graceful degradation where possible |
| 15.5 | Extremely long message | Send 4000+ character text | Processed without truncation issues |
| 15.6 | Special characters | Send emojis, markdown chars (`*`, `_`, `` ` ``) | No Telegram parse_mode crash |
| 15.7 | chatId as string | Verify all DB queries use `String(chatId)` | No type mismatch errors |
| 15.8 | Session without profile | Delete `user_profiles` row but keep session in Redis | `processMessage` throws; caught with friendly error |

---

## Test Execution Checklist

Use this checklist to track progress during a test run:

```
[ ] Module 1  — Infrastructure (4 cases)
[ ] Module 2  — Webhook & Transport (8 cases)
[ ] Module 3  — OTP & Auth (10 cases)
[ ] Module 4  — Onboarding (9 cases)
[ ] Module 5  — Invitations (6 cases)
[ ] Module 6  — Voice Notes (4 cases)
[ ] Module 7  — AI Agentic Loop (12 cases)
[ ] Module 8  — Recipe Overrides (5 cases)
[ ] Module 9  — YouTube Caching (5 cases)
[ ] Module 10 — Cart & Orders (10 cases)
[ ] Module 11 — Smart Top-Up (3 cases)
[ ] Module 12 — Kitchen Routing (7 cases)
[ ] Module 13 — Scheduled Jobs (3 cases)
[ ] Module 14 — Order History (2 cases)
[ ] Module 15 — Edge Cases (8 cases)
──────────────────────────────────
TOTAL: 96 test cases
```

---

## Quick DB Verification Commands

```sql
-- Check kitchen created
SELECT * FROM kitchen_sessions WHERE owner_phone = '<chatId>';

-- Check user profile
SELECT * FROM user_profiles WHERE phone = '<chatId>';

-- Check recipe overrides
SELECT * FROM recipe_overrides WHERE phone = '<chatId>';

-- Check order history
SELECT * FROM order_history WHERE kitchen_id = '<kitchenId>' ORDER BY created_at DESC;

-- Check event log
SELECT * FROM event_log WHERE kitchen_id = '<kitchenId>' ORDER BY created_at DESC;

-- Check YouTube cache
SELECT * FROM youtube_video_cache WHERE dish_name = '<dish>';
```

## Quick Redis Verification Commands

```bash
# Check session
redis-cli GET "session:<chatId>"

# Check onboarding state
redis-cli GET "onboarding:<chatId>"

# Check OTP
redis-cli GET "otp:<chatId>"

# Check chat history
redis-cli GET "chat:<chatId>"

# Check cart
redis-cli GET "cart:<kitchenId>"

# Check cooldown
redis-cli TTL "cooldown:<chatId>"
```
