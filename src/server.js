// Clinic booking API — Koya Cohort 4, Task 1.
// One Express server: the JSON API at the root paths, plus the web page in /public.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { pool, init } = require("./db");

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("API_KEY is not set");
  process.exit(1);
}

const RATE_LIMIT = 5; // attempts per email...
const RATE_WINDOW_SECONDS = 60; // ...per this many seconds
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const fail = (status, message, headers) => {
  throw new HttpError(status, message, headers);
};

function bookingJson(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// Same JSON regardless of key order, so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const encodeCursor = (seq) => Buffer.from(String(seq)).toString("base64url");
function decodeCursor(cursor) {
  const s = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(s) || encodeCursor(s) !== cursor) fail(400, "invalid cursor");
  return s;
}

function keyMatches(given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Wrap async route handlers so thrown errors reach the error handler.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---------- middleware ----------
app.use(
  cors({
    allowedHeaders: ["Content-Type", "X-API-Key", "Idempotency-Key"],
    exposedHeaders: ["Retry-After"],
  })
);

// The web page and health check are public; everything else needs the key.
app.get("/health", (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Level 2: every API request needs the X-API-Key header.
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (!keyMatches(req.get("X-API-Key"))) {
    return res.status(401).json({ error: "missing or invalid API key" });
  }
  next();
});

app.use(express.json({ type: () => true, limit: "1mb" }));

// ---------- Level 1: POST /reset ----------
app.post(
  "/reset",
  route(async (req, res) => {
    const slots = req.body && req.body.slots;
    if (!Array.isArray(slots)) fail(400, "slots must be an array");

    const seen = new Set();
    const rows = slots.map((s, i) => {
      if (!s || typeof s !== "object") fail(400, `slot ${i} must be an object`);
      for (const f of ["id", "provider", "start", "end"]) {
        if (typeof s[f] !== "string" || s[f].trim() === "") fail(400, `slot ${i}: ${f} is required`);
      }
      if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
        fail(400, `slot ${i}: start and end must be date-times`);
      }
      if (seen.has(s.id)) fail(400, `duplicate slot id ${s.id}`);
      seen.add(s.id);
      return s;
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM bookings");
      await client.query("DELETE FROM slots");
      await client.query("DELETE FROM idempotency_keys");
      await client.query("DELETE FROM booking_attempts");
      for (const s of rows) {
        await client.query(
          `INSERT INTO slots (id, provider, start_text, end_text, start_at, end_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [s.id, s.provider, s.start, s.end, new Date(s.start), new Date(s.end)]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(200).json({ ok: true, slots: rows.length });
  })
);

// ---------- Level 1: GET /slots ----------
app.get(
  "/slots",
  route(async (req, res) => {
    const provider = typeof req.query.provider === "string" ? req.query.provider : null;
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_text, s.end_text,
              NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
         FROM slots s
        WHERE ($1::text IS NULL OR s.provider = $1)
        ORDER BY s.start_at ASC, s.id ASC`,
      [provider]
    );
    res.json({
      slots: rows.map((r) => ({ id: r.id, provider: r.provider, start: r.start_text, end: r.end_text, available: r.available })),
    });
  })
);

// ---------- Levels 1-5: POST /bookings ----------
// Everything for one request runs in ONE database transaction, guarded by locks:
//   1. Idempotency-Key lock  -> retries of the same request wait, then replay the saved response (level 4)
//   2. Per-email lock        -> counts attempts in the last 60s and enforces the limit (level 5)
//   3. Slot row lock         -> only one request at a time can book a given slot (level 3)
async function attemptBooking(client, body) {
  // Level 5: rate limit by email (trimmed + lower case). Failed attempts count too.
  const rawEmail = body && typeof body === "object" ? body.email : undefined;
  const rateEmail = typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null;
  if (rateEmail) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["rate:" + rateEmail]);
    await client.query(
      `DELETE FROM booking_attempts WHERE email = $1 AND attempted_at <= clock_timestamp() - make_interval(secs => $2)`,
      [rateEmail, RATE_WINDOW_SECONDS]
    );
    const { rows } = await client.query(
      `SELECT count(*)::int AS n,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (min(attempted_at) + make_interval(secs => $2) - clock_timestamp()))))::int AS retry_after
         FROM booking_attempts
        WHERE email = $1 AND attempted_at > clock_timestamp() - make_interval(secs => $2)`,
      [rateEmail, RATE_WINDOW_SECONDS]
    );
    if (rows[0].n >= RATE_LIMIT) {
      return {
        status: 429,
        body: { error: "too many booking attempts for this email, try again later" },
        headers: { "Retry-After": String(rows[0].retry_after) },
      };
    }
    await client.query("INSERT INTO booking_attempts (email) VALUES ($1)", [rateEmail]);
  }

  try {
    // Level 2: validation
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "body must be a JSON object");
    const { slot_id } = body;
    if (typeof slot_id !== "string" || slot_id.trim() === "") fail(400, "slot_id is required");
    if (typeof body.name !== "string" || body.name.trim() === "") fail(400, "name is required");
    if (typeof body.email !== "string" || body.email.trim() === "") fail(400, "email is required");
    const name = body.name.trim();
    const email = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) fail(400, "email is not valid");

    // Level 3: lock the slot row so concurrent requests for it go one at a time.
    const slot = await client.query(
      `SELECT id, start_at <= clock_timestamp() AS started FROM slots WHERE id = $1 FOR UPDATE`,
      [slot_id]
    );
    if (slot.rows.length === 0) fail(404, "slot not found");
    if (slot.rows[0].started) fail(400, "slot has already started");

    const taken = await client.query(
      `SELECT 1 FROM bookings WHERE slot_id = $1 AND status = 'confirmed'`,
      [slot_id]
    );
    if (taken.rows.length) fail(409, "slot already booked");

    // The unique index is a second line of defence; catch its error as a 409 too.
    await client.query("SAVEPOINT book");
    try {
      const { rows } = await client.query(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
        ["bk_" + crypto.randomUUID(), slot_id, name, email]
      );
      await client.query("RELEASE SAVEPOINT book");
      return { status: 201, body: bookingJson(rows[0]) };
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT book");
      if (err.code === "23505") fail(409, "slot already booked");
      throw err;
    }
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

app.post(
  "/bookings",
  route(async (req, res) => {
    const headerKey = req.get("Idempotency-Key");
    const idemKey = typeof headerKey === "string" && headerKey !== "" ? headerKey : null;
    const bodyHash = sha256(canonical(req.body));

    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");

      // Level 4: same key -> replay saved response; same key + different body -> 422.
      if (idemKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["idem:" + idemKey]);
        const saved = await client.query(
          "SELECT body_hash, status_code, response FROM idempotency_keys WHERE key = $1",
          [idemKey]
        );
        if (saved.rows.length) {
          await client.query("COMMIT");
          const row = saved.rows[0];
          if (row.body_hash !== bodyHash) {
            return res.status(422).json({ error: "Idempotency-Key was already used with a different body" });
          }
          return res.status(row.status_code).json(row.response);
        }
      }

      result = await attemptBooking(client, req.body);

      // Save the outcome for this key. A 429 isn't saved, so the client can retry later.
      if (idemKey && result.status !== 429) {
        await client.query(
          `INSERT INTO idempotency_keys (key, body_hash, status_code, response) VALUES ($1, $2, $3, $4)`,
          [idemKey, bodyHash, result.status, JSON.stringify(result.body)]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    for (const [h, v] of Object.entries(result.headers || {})) res.set(h, v);
    res.status(result.status).json(result.body);
  })
);

// ---------- Level 4: GET /bookings?email=&limit=&cursor= ----------
app.get(
  "/bookings",
  route(async (req, res) => {
    const { email, limit, cursor } = req.query;
    if (typeof email !== "string" || email.trim() === "") fail(400, "email is required");

    let size = 10;
    if (limit !== undefined) {
      if (typeof limit !== "string" || !/^\d+$/.test(limit)) fail(400, "limit must be a whole number from 1 to 50");
      size = Number(limit);
      if (size < 1 || size > 50) fail(400, "limit must be a whole number from 1 to 50");
    }

    let after = "0";
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || cursor === "") fail(400, "invalid cursor");
      after = decodeCursor(cursor);
    }

    const { rows } = await pool.query(
      `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [email.trim().toLowerCase(), after, size + 1]
    );
    const page = rows.slice(0, size);
    const next_cursor = rows.length > size ? encodeCursor(page[page.length - 1].seq) : null;
    res.json({ bookings: page.map(bookingJson), next_cursor });
  })
);

// ---------- Level 1: GET /bookings/:id ----------
app.get(
  "/bookings/:id",
  route(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
    if (!rows.length) fail(404, "booking not found");
    res.json(bookingJson(rows[0]));
  })
);

// ---------- Level 3: DELETE /bookings/:id ----------
app.delete(
  "/bookings/:id",
  route(async (req, res) => {
    // Only flips confirmed -> cancelled, in one atomic statement.
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [req.params.id]
    );
    if (rows.length) return res.json(bookingJson(rows[0]));
    const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
    if (!exists.rows.length) fail(404, "booking not found");
    fail(409, "booking is already cancelled");
  })
);

// ---------- errors ----------
app.use((req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    for (const [h, v] of Object.entries(err.headers)) res.set(h, v);
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "body is not valid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "body too large" });
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ---------- start ----------
async function seedDemoSlotsIfEmpty() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM slots");
  if (rows[0].n > 0) return;
  const providers = ["Dr Ade", "Dr Bisi", "Dr Chuka"];
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);
  let n = 1;
  for (let d = 0; d < 3; d++) {
    for (const [i, provider] of providers.entries()) {
      for (const hour of [9, 11, 14]) {
        const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + d, hour + i % 2, 0));
        const end = new Date(start.getTime() + 30 * 60000);
        const fmt = (x) => x.toISOString().replace(".000Z", "Z");
        await pool.query(
          `INSERT INTO slots (id, provider, start_text, end_text, start_at, end_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          ["s" + n++, provider, fmt(start), fmt(end), start, end]
        );
      }
    }
  }
  console.log("Seeded demo slots");
}

const PORT = process.env.PORT || 3000;
init()
  .then(seedDemoSlotsIfEmpty)
  .then(() => app.listen(PORT, () => console.log(`Clinic booking API listening on ${PORT}`)))
  .catch((err) => {
    console.error("Failed to start", err);
    process.exit(1);
  });
