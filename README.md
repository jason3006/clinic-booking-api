# Clinic booking API

Koya Cohort 4 — Task 1. A JSON API for booking clinic appointment slots, plus a web page that uses it.
Built with **Node.js + Express + PostgreSQL**. One server hosts both the API and the page.

## Run locally

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/clinic API_KEY=your-key npm start
# in another terminal: all contract checks, levels 1–5
BASE_URL=http://localhost:3000 API_KEY=your-key npm test
```

Environment variables: `DATABASE_URL` (Postgres connection string), `API_KEY` (the key clients must send), `PORT` (optional).

## Endpoints

| Method | Path | Level | What it does |
|---|---|---|---|
| POST | `/reset` | 1 | Delete all bookings, replace all slots |
| GET | `/slots?provider=` | 1 | Slots, earliest first, with `available` |
| POST | `/bookings` | 1–5 | Book a slot |
| GET | `/bookings?email=&limit=&cursor=` | 4 | A person's bookings, oldest first, cursor-paginated |
| GET | `/bookings/{id}` | 1 | One booking |
| DELETE | `/bookings/{id}` | 3 | Cancel a booking and free the slot |

Every API request needs `X-API-Key`. Errors are always `{"error": "..."}`.

## How each level is handled

- **Level 1 — persistence.** Everything lives in Postgres, so bookings survive restarts. Slot `start`/`end` are stored exactly as sent (and also as timestamps for sorting).
- **Level 2 — auth and validation.** A middleware checks `X-API-Key` (constant-time compare) before anything else → 401. `name`/`email` are trimmed, email is lower-cased and format-checked → 400. Unknown slot → 404. Slot already started → 400.
- **Level 3 — no double booking.** Inside one transaction the slot row is locked with `SELECT … FOR UPDATE`, so simultaneous requests for the same slot queue up; the first books it, the rest see it taken → 409. A partial unique index (`one confirmed booking per slot`) backs this up at the database level. Cancel is a single atomic `UPDATE … WHERE status = 'confirmed'`.
- **Level 4 — idempotency and pagination.** An `Idempotency-Key` takes a Postgres advisory lock, so concurrent retries wait for the first one. The first response (status + body) is saved with a hash of the request body; a retry with the same body replays it, a different body → 422. Bookings are listed by an insertion sequence number; `next_cursor` encodes the last one returned.
- **Level 5 — rate limiting.** Each attempt is recorded per email (trimmed, lower-case) in Postgres, failures included. A per-email advisory lock makes the count exact under concurrency. The 6th attempt within 60 seconds → 429 with `Retry-After` = seconds until the oldest attempt leaves the window. Because the limit lives in the database, it holds across restarts and multiple server instances.

## Design choices

- One transaction per booking request, with locks taken in a fixed order (idempotency key → email → slot) to avoid deadlocks.
- Idempotent replays are returned before rate limiting, so a client retrying the same request isn't punished. 429 responses aren't saved, so a key can be retried after waiting.
- The web page asks for the API key and keeps it in the browser. In a real clinic the page would call a backend with its own session auth instead of holding the API key.
