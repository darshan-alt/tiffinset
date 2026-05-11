# TiffinSet — Project Context

## What this is
TiffinSet (tiffinset.com) is a voice-first kitchen management bot for Indian households, running on Telegram (WhatsApp-ready via transport abstraction).

## Tech stack
- Node.js 20, Express
- PostgreSQL 16 on localhost:5432 (user: tiffinset_admin, db: tiffinset)
- Redis 7 on localhost:6379 (256MB, allkeys-lru)
- GCP Secret Manager for secrets
- Telegram Bot API (@TiffinSetBot)
- OpenAI Whisper for speech-to-text
- Gemini API (Gemini 3 Flash) for AI orchestration
- YouTube Data API v3 for recipe videos
- GCP Compute Engine e2-small in asia-south1-a (Mumbai)
- Domain: api.tiffinset.com, Nginx + Let's Encrypt SSL

## Architecture
- Transport abstraction: src/transport/telegram.js (active), src/transport/whatsapp.js (future). Core pipeline never calls platform APIs directly.
- Shared kitchen session: multiple users (owner, cook, contributor) linked by kitchen_id, each with 1:1 bot chat
- Auth: Telegram secret_token webhook verification, OTP via Redis (5-min TTL, 3 attempts), session in Redis (30-day TTL)
- Gemini agentic loop with 10 tools: search_recipe, search_youtube_video, search_instamart (mock), add_to_cart, view_cart, place_order, get_recipe_overrides, save_recipe_override, get_order_history, route_to_kitchen_member

## Database (8 tables, all created)
kitchen_sessions, user_profiles, recipe_overrides, order_history, event_log, menu_history, shelf_life_rules, youtube_video_cache

## Secrets (GCP Secret Manager)
TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, WHISPER_API_KEY, YOUTUBE_API_KEY, WEBHOOK_VERIFY_TOKEN, DATABASE_URL

## Build phases
1. Project scaffold + Telegram webhook
2. Whisper speech-to-text
3. Auth + onboarding (OTP, sessions, roles, invite flow)
4. Gemini AI orchestrator (agentic loop with tools)
5. Recipe engine + YouTube video search
6. Kitchen routing + scheduled events
7. Mock Swiggy orders + smart top-up
8. CI/CD + logging + tests

## Rules
- Always use the transport layer for messaging, never direct Telegram/WhatsApp calls
- Respond in Hinglish (Hindi + English) in user-facing messages
- All secrets from GCP Secret Manager, never hardcoded
- chatId is a string (Telegram numeric ID now, WhatsApp phone later)