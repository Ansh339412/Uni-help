# Uni-help

Why buy something you’ll only need for a day? Circlend is a campus lending platform: students list what they aren’t using, and others borrow it through a verified handover and return.

By [Ansh339412](https://github.com/Ansh339412).

## Features
- Search items by category, pickup spot and borrowing window
- Owner availability calendar, with overlapping bookings blocked by the database itself
- Request, approve, hand over and return, verified by a 6-digit PIN or QR code (in-app scanner)
- Instant notifications and live chat (Supabase Realtime)
- "Need It Now": asks the 3 most responsive owners at once, then cancels the rest when one approves
- Reviews, owner ratings, photo uploads, community impact stats (purchases avoided is an estimate), admin tab

## Stack
React, TypeScript, Tailwind CSS, Node.js, Express, PostgreSQL, Supabase (Auth, Storage, Realtime).

## Setup
1. Create a Supabase project and run `schema.sql` in its SQL editor, Parts 1 to 5 in order. Turn on email confirmation under Auth.
2. `cd server && cp .env.example .env`, fill it in, then `npm i && npm run dev`.
3. `cd web && cp .env.example .env`, fill it in, then `npm i && npm run dev`.
4. To become an admin: `update profiles set is_admin = true where id = '<your user id>';`

## Security
- The booking exclusion constraint and row-level security are enforced in Postgres, not just in the API.
- PINs lock a request after 5 wrong attempts. The API rate-limits requests, PIN checks and chat.
- JWTs are checked for algorithm and audience. CORS is locked to `CLIENT_ORIGIN`, and the server won’t start without its settings.
- Uploads are limited to 2 MB images in the user’s own folder, and image URLs must come from your own storage.
- Set `ALLOWED_EMAIL_DOMAIN` to accept only your university’s emails.
- `web/vercel.json` sets a Content-Security-Policy. Replace `YOUR-API.onrender.com` with your API’s address.
- Never commit `.env` files. The Supabase JWT secret and database password stay on the server only.

## Deploy
- API: Render, using `render.yaml`.
- Web: Vercel, with root directory `web`. Camera scanning needs HTTPS.

## Known limits
No automated tests yet. Listings aren’t scoped per campus. Pickup spot matching is text only. Availability works in whole days.
