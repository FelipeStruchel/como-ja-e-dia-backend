Project: Backend (WhatsApp bot core API)

Principles
- Keep this repo API-only; no frontend assets. Use Express routers under routes/, services/ for business logic, models/ for Mongo schemas, middleware/ for auth/log.
- Environment-driven config; never hardcode secrets. Required envs: Mongo (MONGO_URI), Redis (REDIS_HOST/PORT), GROUP_ID/ALLOWED_PING_GROUP, MEDIA_BASE_URL (internal), BACKEND_PUBLIC_URL (external), CONTEXT_INGEST_TOKEN for log ingest, AI keys, etc.
- Authentication: protected routes use requireAuth; public endpoints are minimal (confessions/events as defined).
- Logging: use services/logger.js; log to Mongo via ingest; avoid console-only paths.

Media & URLs
- Media scopes: default media/, trigger media, daily_vid (daily_media) with subfolders image/video/text; random pool uses media scope.
- Always return both internal (MEDIA_BASE_URL) and public (BACKEND_PUBLIC_URL) URLs when relevant; worker consumes internal URLs, frontend shows public URLs.
- Cleanup: only remove files when business rule demands (random pool always cleans after send; daily only on final run if flagged).

Scheduling & Queues
- BullMQ with Redis. Queues: incoming-messages, send-messages, group-context, scheduled-jobs. Repeatables managed in services/scheduledJobs.js; cron override optional; default cron from time+days in America/Sao_Paulo.
- Worker handles WhatsApp I/O; backend only enqueues jobs and manages state.
- Triggers/commands must check group and author JID normalization (@lid -> @c.us when possible).

AI Persona/Caption
- Guardrails live in services/personaConstants.js; personaPrompt is user-editable per schedule but guardrails are always appended. Do not expose guardrails for editing.
- Caption modes: auto (OpenAI), custom, none. Validate inputs to avoid unsafe prompts; return clear error if OpenAI rejects.

General Style
- ES modules, async/await, prefer small functions. Keep validation in parse* helpers. Return JSON errors { error: message } with proper status codes. Avoid breaking existing routes/contract.

Do not
- Do not move WhatsApp client into backend. Do not bypass auth on protected routes. Do not drop logs to stdout without ingest. Do not hardcode URLs or group IDs. Do not delete media before worker sends successfully.
