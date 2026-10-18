# Cloud backend (standalone Cloudflare Worker)

The site can run entirely from its local browser store. D1 event storage is per authenticated Sites user; Calendar sync becomes available after that user grants Google Calendar access. The Worker never uses a shared fallback identity: requests without a valid Sites identity or standalone signed session return `401`.

## Configure

1. Create a D1 database named `memo-calendar-glass`, put its ID in `wrangler.jsonc`, and run `npx wrangler d1 migrations apply memo-calendar-glass --remote`.
2. In Google Cloud Console, enable the Google Calendar API and create a **Web application** OAuth client. Register `https://<worker-host>/api/google/callback` as an authorized redirect URI. OAuth consent requests OpenID identity plus `calendar.events` access.
3. Set Worker secrets with `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY`. Generate the last value with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`; generate the session secret independently with at least 32 random bytes. Never commit real secrets or `.dev.vars`.
4. Deploy with `npx wrangler deploy`, then register the exact deployed app origin plus `/api/google/callback` as the OAuth redirect URI. `APP_ORIGIN` is optional and defaults to the current HTTPS origin; set it only when the allowed app origin differs from the Worker origin.

In the private Sites runtime, bind `DB` to D1 and set `TRUST_SITES_IDENTITY=true`; the Worker reads Sites' `oai-authenticated-user-id` header, which the private Sites dispatcher supplies. Never enable that setting on a public standalone Worker. Standalone Wrangler uses a Google account session cookie (`TRUST_SITES_IDENTITY=false`) and may be deployed independently. For local development use `npx wrangler dev`; add `.dev.vars` from `.dev.vars.example` and register the resulting local callback URI for the OAuth client if testing the full flow.

## API contract

- `GET /api/status`: returns storage, AI, signed-in state, and Google setup/connection status without exposing identity or token data. `accountKey` is a short hash used to partition client preferences; a Google Calendar grant is not required for authenticated D1 CRUD.
- `POST /api/parse` with `{text, timezone?}`: authenticated requests may use Workers AI to extract event details only after the deterministic parser has identified a date and start time. Anonymous requests never invoke AI; they use the deterministic parser. Missing start time is a clarification.
- `GET /api/events`, `POST /api/events`, `PUT /api/events/:id`, `DELETE /api/events/:id`: per-user event storage. A missing end time defaults to one hour after the explicit start. Send `autoSync:true` with create/update only after the user enables automatic Calendar addition; responses include a sync status and report partial failure explicitly.
- `GET /api/google/connect`: starts OAuth 2.0 authorization code flow with state and PKCE. `/api/google/callback` verifies state, exchanges the code, validates the returned ID token with Google's tokeninfo endpoint, and sets an HttpOnly session cookie.
- `POST /api/google/sync` with optional `{eventIds:[]}`: upserts events to the primary Google Calendar using a deterministic event ID. Each item reports success or failure so a partial sync is visible and safe to retry.

Refresh tokens are encrypted with AES-GCM before D1 storage. Standalone session cookies are signed, HttpOnly, Secure, and SameSite=Lax. Mutating requests validate same-origin; configure `APP_ORIGIN` exactly. Calendar event writes use a deterministic valid event ID and retry a concurrent insert conflict as PATCH, making retries duplicate-safe. A delete removes the remote event first and keeps the local record if Google cannot confirm deletion. Repeating items are stored as RRULE values; the front-end parser is responsible for turning a numbered series request into individual titled events.

If D1 is missing, status reports local mode and mutation routes return `503`; the UI should keep using its browser-local store. If Google or AI credentials are missing, status reports that explicitly.
