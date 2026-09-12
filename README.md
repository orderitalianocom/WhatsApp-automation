# RakibFlow WhatsApp Inbox — Full Starter

A self-hosted WhatsApp Cloud API inbox starter with:

- WhatsApp-inspired light UI (teal accents, chat bubbles, read receipts)
- Conversation list + search
- Supabase (Postgres) persistence -- works on serverless hosts like Vercel
- Meta webhook verification
- Incoming WhatsApp message storage
- Delivery/read status updates
- Manual text replies through Meta Cloud API
- Template-send API endpoint
- Server-side access token
- 24-hour UI indicator
- Mobile-responsive inbox (with hamburger menu for the conversation list)

## Run locally

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Put your Meta values and Supabase project URL/service_role key in `.env`.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://YOUR_SERVER:3000`.

## Deploying

See `DEPLOYMENT.md` for VPS, Railway, and Vercel instructions. Vercel is the recommended path now that storage is Supabase-backed instead of a local SQLite file.

## Meta webhook

Set your Meta webhook callback URL to:

`https://YOUR-DOMAIN/webhook`

Use the exact value from `META_VERIFY_TOKEN` as the verification token.

Subscribe the WhatsApp business account to the webhook fields needed for messages/statuses.

## Production notes

- Put the app behind HTTPS (a reverse proxy on a VPS, or Vercel/Railway's built-in HTTPS).
- Keep `WHATSAPP_ACCESS_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` only in server-side environment variables -- never in client code.
- Use a strong `META_VERIFY_TOKEN`.
- Set `DASHBOARD_PASSWORD` or replace the simple shared-password middleware with proper user authentication.
- The `contacts`, `conversations`, and `messages` tables have Row Level Security enabled with no public policies, so only the `service_role` key (used by the backend) can read/write them.
- Add CSRF/rate limiting/session auth before exposing the dashboard publicly.
- Add media download/upload handling for images, audio, documents and video.
- Add proper agent/team permissions if multiple staff will use the inbox.
- The 24-hour indicator is only a UI aid; production messaging rules should be enforced server-side.
- For business-initiated messages outside the customer-service window, use an approved WhatsApp template.
- Do not use this starter to send spam, unsolicited bulk messages, or to bypass Meta policies.

## API

`GET /api/conversations`

`GET /api/conversations/:id/messages`

`POST /api/send/text`
```json
{"conversationId":1,"text":"Hello"}
```

`POST /api/send/template`
```json
{"conversationId":1,"name":"hello_world","languageCode":"en_US","components":[]}
```
