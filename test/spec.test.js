// Checks every rule in the Koya openapi contract against a running server.
// Usage: BASE_URL=http://localhost:3000 API_KEY=yourkey node test/spec.test.js
const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.API_KEY || "test-key";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log("  PASS", name); }
  else { failed++; console.log("  FAIL", name, extra); }
}

async function call(method, path, { body, key = KEY, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-API-Key"] = key;
  if (body !== undefined || raw !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

const future = (mins) => new Date(Date.now() + mins * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
const past = (mins) => new Date(Date.now() - mins * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
let emailN = 0;
const email = () => `user${Date.now()}_${emailN++}@example.com`;

async function reset(slots) {
  return call("POST", "/reset", { body: { slots } });
}

function baseSlots() {
  return [
    { id: "s2", provider: "Dr Ade", start: future(120), end: future(150) },
    { id: "s1", provider: "Dr Ade", start: future(60), end: future(90) },
    { id: "s3", provider: "Dr Bisi", start: future(30), end: future(60) },
    { id: "old", provider: "Dr Ade", start: past(60), end: past(30) },
  ];
}

async function level1() {
  console.log("Level 1");
  const slots = baseSlots();
  const r = await reset(slots);
  check("reset returns 200", r.status === 200, r.status);

  const s = await call("GET", "/slots");
  check("GET /slots 200", s.status === 200);
  const ids = s.json.slots.map((x) => x.id);
  check("slots earliest start first", JSON.stringify(ids) === JSON.stringify(["old", "s3", "s1", "s2"]), ids);
  check("slot keeps exact start string", s.json.slots.find((x) => x.id === "s1").start === slots[1].start);
  check("all available initially", s.json.slots.every((x) => x.available === true));

  const p = await call("GET", "/slots?provider=" + encodeURIComponent("Dr Bisi"));
  check("provider filter exact", p.json.slots.length === 1 && p.json.slots[0].id === "s3");
  const p2 = await call("GET", "/slots?provider=dr%20bisi");
  check("provider filter is exact match", p2.json.slots.length === 0);

  const b = await call("POST", "/bookings", { body: { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" } });
  check("book returns 201", b.status === 201, JSON.stringify(b.json));
  check("booking confirmed", b.json && b.json.status === "confirmed");
  for (const f of ["id", "slot_id", "name", "email", "status", "created_at"]) check("booking has " + f, b.json && f in b.json);

  const g = await call("GET", "/bookings/" + b.json.id);
  check("get booking 200", g.status === 200 && g.json.id === b.json.id);
  const g404 = await call("GET", "/bookings/nope");
  check("get unknown booking 404", g404.status === 404 && typeof g404.json.error === "string");

  const s2 = await call("GET", "/slots");
  check("booked slot unavailable", s2.json.slots.find((x) => x.id === "s1").available === false);

  const r2 = await reset(baseSlots());
  const g2 = await call("GET", "/bookings/" + b.json.id);
  check("reset deletes bookings", r2.status === 200 && g2.status === 404);
}

async function level2() {
  console.log("Level 2");
  await reset(baseSlots());
  check("missing key 401", (await call("GET", "/slots", { key: null })).status === 401);
  const w = await call("GET", "/slots", { key: "wrong" });
  check("wrong key 401 with error", w.status === 401 && typeof w.json.error === "string");
  check("POST /bookings without key 401", (await call("POST", "/bookings", { key: null, body: {} })).status === 401);

  const cases = [
    ["missing slot_id", { name: "A", email: email() }, 400],
    ["missing name", { slot_id: "s1", email: email() }, 400],
    ["missing email", { slot_id: "s1", name: "A" }, 400],
    ["empty name", { slot_id: "s1", name: "   ", email: email() }, 400],
    ["empty slot_id", { slot_id: "", name: "A", email: email() }, 400],
    ["invalid email", { slot_id: "s1", name: "A", email: "not-an-email" }, 400],
    ["unknown slot", { slot_id: "zzz", name: "A", email: email() }, 404],
    ["started slot", { slot_id: "old", name: "A", email: email() }, 400],
  ];
  for (const [n, body, code] of cases) {
    const r = await call("POST", "/bookings", { body });
    check(n + " -> " + code, r.status === code && typeof r.json.error === "string", `${r.status} ${JSON.stringify(r.json)}`);
  }
  const bad = await call("POST", "/bookings", { raw: "{not json" });
  check("malformed JSON -> 400", bad.status === 400 && typeof bad.json.error === "string");

  const t = await call("POST", "/bookings", { body: { slot_id: "s1", name: "  Ada Obi  ", email: "  ADA.Obi@Example.COM " } });
  check("trim + lowercase", t.status === 201 && t.json.name === "Ada Obi" && t.json.email === "ada.obi@example.com", JSON.stringify(t.json));
}

async function level3() {
  console.log("Level 3");
  await reset(baseSlots());
  const N = 25;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      call("POST", "/bookings", { body: { slot_id: "s2", name: "P" + i, email: `race${i}_${Date.now()}@example.com` } })
    )
  );
  const ok = results.filter((r) => r.status === 201).length;
  const conflict = results.filter((r) => r.status === 409).length;
  check(`concurrent: exactly one 201 (${ok}) rest 409 (${conflict})`, ok === 1 && conflict === N - 1);

  const winner = results.find((r) => r.status === 201).json;
  const c = await call("DELETE", "/bookings/" + winner.id);
  check("cancel 200 cancelled", c.status === 200 && c.json.status === "cancelled");
  const c2 = await call("DELETE", "/bookings/" + winner.id);
  check("cancel again 409", c2.status === 409);
  check("cancel unknown 404", (await call("DELETE", "/bookings/nope")).status === 404);
  const s = await call("GET", "/slots");
  check("slot freed after cancel", s.json.slots.find((x) => x.id === "s2").available === true);
  const rebook = await call("POST", "/bookings", { body: { slot_id: "s2", name: "New", email: email() } });
  check("rebook freed slot 201", rebook.status === 201);
}

async function level4() {
  console.log("Level 4");
  await reset(baseSlots());
  const e = email();
  const body = { slot_id: "s1", name: "Idem", email: e };
  const k = "idem-" + Date.now();
  const first = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": k } });
  const second = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": k } });
  check("idempotent replay same status+id", first.status === 201 && second.status === 201 && first.json.id === second.json.id);
  const diff = await call("POST", "/bookings", { body: { ...body, name: "Other" }, headers: { "Idempotency-Key": k } });
  check("same key different body 422", diff.status === 422);

  // concurrent retries with the same key
  const k2 = "idem-par-" + Date.now();
  const body2 = { slot_id: "s2", name: "Par", email: email() };
  const par = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/bookings", { body: body2, headers: { "Idempotency-Key": k2 } })));
  const parIds = new Set(par.map((r) => r.json && r.json.id));
  check("concurrent same key -> one booking", par.every((r) => r.status === 201) && parIds.size === 1, par.map((r) => r.status));

  // pagination
  const slots = Array.from({ length: 7 }, (_, i) => ({ id: "p" + i, provider: "Dr P", start: future(200 + i * 30), end: future(230 + i * 30) }));
  await reset(slots);
  const pe = email();
  const made = [];
  for (let i = 0; i < 4; i++) {
    const r = await call("POST", "/bookings", { body: { slot_id: "p" + i, name: "Pager", email: pe } });
    made.push(r.json.id);
  }
  await new Promise((r) => setTimeout(r, 0));
  const pe2 = email(); // second person, should not show up
  await call("POST", "/bookings", { body: { slot_id: "p5", name: "Else", email: pe2 } });

  const page1 = await call("GET", `/bookings?email=${encodeURIComponent(pe.toUpperCase())}&limit=3`);
  check("page1 has 3, oldest first", page1.status === 200 && JSON.stringify(page1.json.bookings.map((b) => b.id)) === JSON.stringify(made.slice(0, 3)));
  check("page1 next_cursor string", typeof page1.json.next_cursor === "string");
  const page2 = await call("GET", `/bookings?email=${encodeURIComponent(pe)}&limit=3&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
  check("page2 has last one, next_cursor null", page2.json.bookings.length === 1 && page2.json.bookings[0].id === made[3] && page2.json.next_cursor === null);
  const dflt = await call("GET", `/bookings?email=${encodeURIComponent(pe)}`);
  check("default limit returns all 4, null cursor", dflt.json.bookings.length === 4 && dflt.json.next_cursor === null);
  for (const l of ["0", "51", "abc", "1.5", "-1", ""]) {
    const r = await call("GET", `/bookings?email=${encodeURIComponent(pe)}&limit=${l}`);
    check(`limit=${JSON.stringify(l)} -> 400`, r.status === 400, r.status);
  }
  check("limit=50 ok", (await call("GET", `/bookings?email=${encodeURIComponent(pe)}&limit=50`)).status === 200);
  check("limit=1 ok", (await call("GET", `/bookings?email=${encodeURIComponent(pe)}&limit=1`)).status === 200);
  check("missing email -> 400", (await call("GET", `/bookings`)).status === 400);
  check("bad cursor -> 400", (await call("GET", `/bookings?email=${encodeURIComponent(pe)}&cursor=garbage!!`)).status === 400);
}

async function level5() {
  console.log("Level 5");
  const slots = Array.from({ length: 10 }, (_, i) => ({ id: "r" + i, provider: "Dr R", start: future(300 + i * 30), end: future(330 + i * 30) }));
  await reset(slots);
  const e = email();
  const statuses = [];
  // mix of successes and failures: all count
  for (let i = 0; i < 5; i++) {
    const body = i % 2 === 0 ? { slot_id: "r" + i, name: "Spam", email: e } : { slot_id: "missing", name: "Spam", email: e };
    statuses.push((await call("POST", "/bookings", { body })).status);
  }
  check("first 5 not 429", statuses.every((s) => s !== 429), statuses);
  const sixth = await call("POST", "/bookings", { body: { slot_id: "r8", name: "Spam", email: e.toUpperCase() } });
  const ra = sixth.headers.get("retry-after");
  check("6th -> 429", sixth.status === 429 && typeof sixth.json.error === "string", sixth.status);
  check("Retry-After whole seconds 1..60", ra !== null && /^\d+$/.test(ra) && +ra >= 1 && +ra <= 60, ra);
  const other = await call("POST", "/bookings", { body: { slot_id: "r9", name: "Other", email: email() } });
  check("other email unaffected", other.status === 201);

  // concurrent burst on a fresh email: exactly 5 get through the limiter
  const e2 = email();
  const burst = await Promise.all(Array.from({ length: 12 }, () => call("POST", "/bookings", { body: { slot_id: "missing", name: "B", email: e2 } })));
  const limited = burst.filter((r) => r.status === 429).length;
  check(`concurrent burst: 7 of 12 limited (${limited})`, limited === 7);
}

(async () => {
  for (const lvl of [level1, level2, level3, level4, level5]) {
    try { await lvl(); } catch (err) { failed++; console.log("  ERROR", err.message); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
