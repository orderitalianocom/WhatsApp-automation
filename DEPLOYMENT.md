# Simple VPS deployment

Example with Ubuntu:

1. Install Node.js 20+.
2. Upload this folder.
3. `npm install`
4. `cp .env.example .env`
5. Edit `.env`.
6. `npm start`

For production, run it with a process manager such as systemd/PM2 and put HTTPS in front of it.

Do not expose port 3000 directly if you can avoid it; use Nginx/Caddy as the public HTTPS endpoint.

Your public webhook URL should be:
`https://YOUR-DOMAIN/webhook`

## Deploying on Railway

1. Push this repo to GitHub (already done if you're reading this from GitHub).
2. Go to railway.app, sign in, and choose "Deploy from GitHub repo".
3. Select this repository.
4. In the Railway dashboard, add the environment variables from `.env.example`:
   - `WHATSAPP_ACCESS_TOKEN`
   - `PHONE_NUMBER_ID`
   - `WABA_ID`
   - `GRAPH_VERSION`
   - `META_VERIFY_TOKEN`
   - `DASHBOARD_PASSWORD`
5. Railway will detect `npm start` and deploy automatically. It also assigns a public HTTPS URL.
6. Set your Meta webhook callback URL to `https://YOUR-RAILWAY-URL/webhook`, using `META_VERIFY_TOKEN` as the verify token.
7. Subscribe your WhatsApp Business Account to the webhook (messages/statuses fields).

Note: Railway's filesystem is ephemeral across redeploys unless you attach a persistent volume. For production, consider mounting a volume at `data/` so `rakibflow.db` survives redeploys, or migrate to a managed database (e.g. Postgres) once conversation volume grows.
