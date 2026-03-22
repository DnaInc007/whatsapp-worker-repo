# FDispatch WhatsApp Worker

Standalone Baileys worker for FDispatch.

## Required environment variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WHATSAPP_INTERNAL_WEBHOOK_SECRET`
- `APP_URL`

## Local run

```bash
npm install
cp .env.example .env
npm run whatsapp:worker
```

## Docker run

```bash
cp .env.example .env
docker compose up -d --build
```
