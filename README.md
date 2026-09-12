# RakibFlow WhatsApp Inbox — Full Starter

A self-hosted WhatsApp Cloud API inbox starter with:

- WhatsApp-inspired light UI (teal accents, chat bubbles, read receipts)
- Conversation list + search
- SQLite persistence
- Meta webhook verification
- Incoming WhatsApp message storage
- Delivery/read status updates
- Manual text replies through Meta Cloud API
- Template-send API endpoint
- Server-side access token
- 24-hour UI indicator
- Mobile-responsive inbox (with hamburger menu for the conversation list)

## Run

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Put your Meta values in `.env`.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://YOUR_SERVER:3000`.

## Meta webhook

Set your Meta webhook callback URL to:

`https://YOUR-DOMAIN/webhook`

Use the exact value from `META_VERIFY_TOKEN` as the verification token.

Subscribe the WhatsApp business account to the webhook fields needed for messages/statuses.

## Production notes

- Put the app behind HTTPS and a reverse proxy (Nginx/Caddy/Cloudflare).
- Keep `WHATSAPP_ACCESS_TOKEN` only in `.env` on the server.
- Use a strong `META_VERIFY_TOKEN`.
- Set `DASHBOARD_PASSWORD` or replace the simple shared-password middleware with proper user authentication.
- Back up `data/rakibflow.db`.
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
