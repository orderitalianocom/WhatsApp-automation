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
4. In the Railway dashboard, add the environment variables from `.env.example`.
5. Railway will detect `npm start` and deploy automatically. It also assigns a public HTTPS URL.
6. Set your Meta webhook callback URL to `https://YOUR-RAILWAY-URL/webhook`, using `META_VERIFY_TOKEN` as the verify token.
7. Subscribe your WhatsApp Business Account to the webhook (messages/statuses fields).

Note: Railway's filesystem is ephemeral across redeploys unless you attach a persistent volume.

## Deploying on Vercel

This project now stores data in Supabase (Postgres) instead of a local SQLite file, so it works on Vercel's serverless, ephemeral filesystem.

1. A Supabase project has already been created for this app (tables: `contacts`, `conversations`, `messages`, plus a `conversation_list` view). Row Level Security is enabled on all tables with no public policies, so only the `service_role` key can read/write them.
2. In the Vercel dashboard, import this GitHub repository as a new project. Vercel will detect `api/index.js` as a serverless function and serve `public/` as static files automatically (see `vercel.json` for the routing rules).
3. Add these Environment Variables in the Vercel project settings:
   - `WHATSAPP_ACCESS_TOKEN`
   - `PHONE_NUMBER_ID`
   - `WABA_ID`
   - `GRAPH_VERSION`
   - `META_VERIFY_TOKEN`
   - `DASHBOARD_PASSWORD`
   - `SUPABASE_URL` (from Supabase: Settings -> API -> Project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` (from Supabase: Settings -> API -> service_role secret -- never expose this to the browser)
4. Deploy. Vercel gives you a public HTTPS URL automatically.
5. Set your Meta webhook callback URL to `https://YOUR-VERCEL-URL/webhook`, using `META_VERIFY_TOKEN` as the verify token.
6. Subscribe your WhatsApp Business Account to the webhook (messages/statuses fields).

Note: each serverless invocation creates its own Supabase client; this is fine at small-to-medium volume. For very high traffic, consider Supabase's connection pooler settings.
