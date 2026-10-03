import { DurableObject } from "cloudflare:workers";
import { CLINIC, PRACTITIONERS, TREATMENTS, HOURS } from "./config.js";

// ---------- time helpers (clinic local time) ----------

function londonNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toTime = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const treatment = (name) => TREATMENTS.find((t) => t.name === name);
const prac = (id) => PRACTITIONERS.find((p) => p.id === id);
const money = (p) => `£${(p / 100).toFixed(p % 100 ? 2 : 0)}`;

function bookable(date) {
  const today = londonNow().date;
  return isDate(date) && date >= today && date <= addDays(today, CLINIC.daysAhead) && !!HOURS[weekday(date)];
}

// ---------- storage ----------

export class Clinic extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      treatment TEXT NOT NULL,
      staff TEXT NOT NULL,
      date TEXT NOT NULL,
      start INTEGER NOT NULL,
      mins INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      deposit INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      payment_intent TEXT,
      paid_demo INTEGER NOT NULL DEFAULT 0,
      refunded INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      created TEXT NOT NULL
    )`);
  }

  // ----- profiles (photo + description shown on the website) -----
  profiles() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS profiles (staff TEXT PRIMARY KEY, bio TEXT NOT NULL DEFAULT '', photo BLOB, updated TEXT)");
    return this.sql.exec("SELECT staff, bio, updated, photo IS NOT NULL AS hasPhoto FROM profiles").toArray();
  }
  setBio(staff, bio) {
    this.profiles();
    this.sql.exec(`INSERT INTO profiles (staff, bio, updated) VALUES (?, ?, ?)
      ON CONFLICT (staff) DO UPDATE SET bio = excluded.bio, updated = excluded.updated`, staff, bio, new Date().toISOString());
  }
  setPhoto(staff, bytes) {
    this.profiles();
    this.sql.exec(`INSERT INTO profiles (staff, photo, updated) VALUES (?, ?, ?)
      ON CONFLICT (staff) DO UPDATE SET photo = excluded.photo, updated = excluded.updated`, staff, bytes, new Date().toISOString());
  }
  photo(staff) {
    this.profiles();
    const r = this.sql.exec("SELECT photo FROM profiles WHERE staff = ?", staff).toArray()[0];
    return r && r.photo ? r.photo : null;
  }

  // Busy intervals for a practitioner on a day (confirmed, blocked, or held while paying).
  busy(staff, date) {
    const cutoff = new Date(Date.now() - CLINIC.holdMinutes * 60000).toISOString();
    return this.sql.exec(
      `SELECT start, mins FROM bookings WHERE staff = ? AND date = ?
       AND (status IN ('confirmed','blocked') OR (status = 'pending' AND created > ?))`,
      staff, date, cutoff,
    ).toArray();
  }

  // Insert a booking only if the time is still free (runs atomically inside the Durable Object).
  hold(b) {
    const clash = this.busy(b.staff, b.date).some((x) => b.start < x.start + x.mins && x.start < b.start + b.mins);
    if (clash) return null;
    const id = crypto.randomUUID().slice(0, 8);
    const token = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO bookings (id, token, treatment, staff, date, start, mins, name, phone, email, notes, status, deposit, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, token, b.treatment, b.staff, b.date, b.start, b.mins, b.name || "", b.phone || "", b.email || "", b.notes || "",
      b.status || "pending", b.deposit || 0, new Date().toISOString(),
    );
    return { id, token };
  }

  get(id) { return this.sql.exec("SELECT * FROM bookings WHERE id = ?", id).toArray()[0] || null; }
  setSession(id, sessionId) { this.sql.exec("UPDATE bookings SET session_id = ? WHERE id = ?", sessionId, id); }

  confirm(id, { paymentIntent, demo }) {
    this.sql.exec(
      "UPDATE bookings SET status = 'confirmed', payment_intent = COALESCE(?, payment_intent), paid_demo = ? WHERE id = ? AND status = 'pending'",
      paymentIntent || null, demo ? 1 : 0, id,
    );
    return this.get(id);
  }

  release(id, token) {
    return this.sql.exec("DELETE FROM bookings WHERE id = ? AND token = ? AND status = 'pending'", id, token).rowsWritten > 0;
  }

  forDate(date) {
    const cutoff = new Date(Date.now() - CLINIC.holdMinutes * 60000).toISOString();
    return this.sql.exec(
      `SELECT id, treatment, staff, date, start, mins, name, phone, email, notes, status, deposit, paid_demo, refunded, cancel_reason, created
       FROM bookings WHERE date = ? AND (status != 'pending' OR created > ?) ORDER BY start`,
      date, cutoff,
    ).toArray();
  }

  range(from, to) {
    return this.sql.exec(
      `SELECT id, treatment, staff, date, start, mins, name, phone, email, notes, status, deposit, paid_demo, refunded, cancel_reason, created
       FROM bookings WHERE date >= ? AND date <= ? AND status IN ('confirmed','cancelled') ORDER BY date, start`,
      from, to,
    ).toArray();
  }

  monthCounts(month, staff) {
    const q = "SELECT date, COUNT(*) AS n FROM bookings WHERE date LIKE ? AND status = 'confirmed'";
    const rows = staff ? this.sql.exec(q + " AND staff = ? GROUP BY date", `${month}-%`, staff) : this.sql.exec(q + " GROUP BY date", `${month}-%`);
    return Object.fromEntries(rows.toArray().map((r) => [r.date, r.n]));
  }

  cancel(id, reason, refunded) {
    this.sql.exec(
      "UPDATE bookings SET status = 'cancelled', cancel_reason = ?, refunded = ? WHERE id = ? AND status = 'confirmed'",
      reason || "", refunded ? 1 : 0, id,
    );
    return this.get(id);
  }

  remove(id, staff) {
    const q = "DELETE FROM bookings WHERE id = ? AND status IN ('blocked','cancelled')";
    return (staff ? this.sql.exec(q + " AND staff = ?", id, staff) : this.sql.exec(q, id)).rowsWritten > 0;
  }
}

// ---------- availability ----------

async function freeStarts(store, staff, date, mins) {
  const h = HOURS[weekday(date)];
  if (!h) return [];
  const busy = await store.busy(staff, date);
  const now = londonNow();
  const out = [];
  for (let s = toMin(h.open); s + mins <= toMin(h.close); s += CLINIC.stepMinutes) {
    if (date === now.date && s <= toMin(now.time)) continue;
    if (busy.some((x) => s < x.start + x.mins && x.start < s + mins)) continue;
    out.push(s);
  }
  return out;
}

// ---------- Stripe (test mode works with a sk_test_ key) ----------

async function stripe(env, path, params, method = "POST") {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
}

// ---------- staff logins ----------
// Each person has their own PIN. Lucy is the owner and sees everyone.
// Set real PINs in Cloudflare (Settings > Variables and Secrets): PIN_LUCY, PIN_VIC, PIN_LOTTIE
const OWNER = "lucy";
const DEMO_PINS = { lucy: "1111", vic: "2222", lottie: "3333" };
function login(request, env) {
  const id = request.headers.get("x-staff") || "";
  if (!prac(id)) return null;
  const pin = env[`PIN_${id.toUpperCase()}`] || DEMO_PINS[id];
  if (!pin || request.headers.get("x-pin") !== pin) return null;
  return { id, owner: id === OWNER };
}

// ---------- HTTP ----------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, max);

const publicBooking = (b) => b && ({
  id: b.id, treatment: b.treatment, staff: prac(b.staff)?.name || b.staff, date: b.date, time: toTime(b.start),
  mins: b.mins, deposit: money(b.deposit), status: b.status, name: b.name, demo: !!b.paid_demo,
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const store = env.CLINIC.get(env.CLINIC.idFromName("clinic"));
    const path = url.pathname;
    const isJson = (request.headers.get("content-type") || "").includes("application/json");
    const body = request.method === "POST" && isJson ? await request.json().catch(() => ({})) : {};

    // ----- public -----
    if (path === "/api/profiles") {
      const rows = await store.profiles();
      return json({ practitioners: PRACTITIONERS.map((p) => {
        const r = rows.find((x) => x.staff === p.id);
        return { ...p, bio: r?.bio || "", photo: r?.hasPhoto ? `/api/photo/${p.id}?v=${encodeURIComponent(r.updated)}` : null };
      }) });
    }
    const photoMatch = path.match(/^\/api\/photo\/([a-z0-9-]+)$/);
    if (photoMatch) {
      const bytes = await store.photo(photoMatch[1]);
      if (!bytes) return new Response("Not found", { status: 404 });
      return new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
    }

    if (path === "/api/config") {
      return json({
        practitioners: PRACTITIONERS,
        treatments: TREATMENTS.map((t) => ({ name: t.name, mins: t.mins, deposit: money(t.deposit), who: t.who })),
        hours: HOURS, today: londonNow().date, daysAhead: CLINIC.daysAhead,
        payments: env.STRIPE_SECRET_KEY ? "stripe" : "demo",
      });
    }

    if (path === "/api/slots") {
      const t = treatment(url.searchParams.get("treatment"));
      const who = url.searchParams.get("who") || "any";
      const date = url.searchParams.get("date");
      if (!t) return json({ error: "Choose a treatment" }, 400);
      if (!bookable(date)) return json({ date, slots: [] });
      const staffList = who === "any" ? t.who : t.who.includes(who) ? [who] : [];
      const all = new Set();
      for (const s of staffList) (await freeStarts(store, s, date, t.mins)).forEach((m) => all.add(m));
      return json({ date, slots: [...all].sort((a, b) => a - b).map(toTime) });
    }

    if (path === "/api/checkout" && request.method === "POST") {
      const t = treatment(body.treatment);
      if (!t) return json({ error: "Choose a treatment" }, 400);
      if (!bookable(body.date)) return json({ error: "Choose a date" }, 400);
      if (!/^\d{2}:\d{2}$/.test(body.time || "")) return json({ error: "Choose a time" }, 400);
      const name = clean(body.name, 80), phone = clean(body.phone, 30), email = clean(body.email, 120);
      if (name.length < 2) return json({ error: "Please enter your name" }, 400);
      if (phone.replace(/\D/g, "").length < 10) return json({ error: "Please enter a valid mobile number" }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Please enter a valid email" }, 400);

      const start = toMin(body.time);
      const candidates = body.who && body.who !== "any" ? (t.who.includes(body.who) ? [body.who] : []) : t.who;
      let held = null, staff = null;
      for (const s of candidates) {
        if (!(await freeStarts(store, s, body.date, t.mins)).includes(start)) continue;
        held = await store.hold({
          treatment: t.name, staff: s, date: body.date, start, mins: t.mins,
          name, phone, email, notes: clean(body.notes, 600), deposit: t.deposit,
        });
        if (held) { staff = s; break; }
      }
      if (!held) return json({ error: "Sorry, that time has just gone. Please pick another." }, 409);

      const back = `${url.origin}/?b=${held.id}&t=${held.token}`;
      if (!env.STRIPE_SECRET_KEY) return json({ url: `${url.origin}/pay.html?b=${held.id}&t=${held.token}` });

      try {
        const session = await stripe(env, "checkout/sessions", {
          mode: "payment",
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": CLINIC.currency,
          "line_items[0][price_data][unit_amount]": String(t.deposit),
          "line_items[0][price_data][product_data][name]": `Deposit: ${t.name}`,
          "line_items[0][price_data][product_data][description]": `${prac(staff).name}, ${body.date} at ${body.time}. Taken off the price of your treatment.`,
          customer_email: email,
          "metadata[booking_id]": held.id,
          expires_at: String(Math.floor(Date.now() / 1000) + CLINIC.holdMinutes * 60 + 60),
          success_url: `${back}&session_id={CHECKOUT_SESSION_ID}#book`,
          cancel_url: `${back}&cancelled=1#book`,
        });
        await store.setSession(held.id, session.id);
        return json({ url: session.url });
      } catch (e) {
        await store.release(held.id, held.token);
        return json({ error: `Payment could not start: ${e.message}` }, 502);
      }
    }

    if (path === "/api/confirm" && request.method === "POST") {
      const b = await store.get(clean(body.id, 20));
      if (!b || b.token !== body.token) return json({ error: "Booking not found" }, 404);
      if (b.status === "confirmed") return json({ booking: publicBooking(b) });
      if (b.status !== "pending") return json({ error: "This booking is no longer active" }, 410);
      if (env.STRIPE_SECRET_KEY && b.session_id) {
        const s = await stripe(env, `checkout/sessions/${b.session_id}`, null, "GET").catch(() => null);
        if (s && s.payment_status === "paid" && s.metadata?.booking_id === b.id) {
          return json({ booking: publicBooking(await store.confirm(b.id, { paymentIntent: s.payment_intent })) });
        }
      }
      return json({ booking: publicBooking(b) });
    }

    if (path === "/api/release" && request.method === "POST") {
      await store.release(clean(body.id, 20), clean(body.token, 60));
      return json({ ok: true });
    }

    // Demo checkout (only when no Stripe key is set)
    if (path === "/api/demo-booking") {
      const b = await store.get(clean(url.searchParams.get("b"), 20));
      if (!b || b.token !== url.searchParams.get("t")) return json({ error: "Booking not found" }, 404);
      return json({ booking: publicBooking(b) });
    }
    if (path === "/api/demo-pay" && request.method === "POST") {
      if (env.STRIPE_SECRET_KEY) return json({ error: "Demo payments are off" }, 403);
      const b = await store.get(clean(body.id, 20));
      if (!b || b.token !== body.token) return json({ error: "Booking not found" }, 404);
      if (b.status !== "pending") return json({ booking: publicBooking(b) });
      if (Date.now() - Date.parse(b.created) > CLINIC.holdMinutes * 60000) {
        await store.release(b.id, b.token);
        return json({ error: "Sorry, this booking timed out. Please choose your time again." }, 410);
      }
      return json({ booking: publicBooking(await store.confirm(b.id, { demo: true })) });
    }

    // ----- staff logins -----
    if (path.startsWith("/api/admin/")) {
      const me = login(request, env);
      if (!me) return json({ error: "Wrong name or PIN" }, 401);
      const mine = (rows) => (me.owner ? rows : rows.filter((b) => b.staff === me.id));

      if (path === "/api/admin/me") {
        return json({ id: me.id, name: prac(me.id).name, owner: me.owner, payments: env.STRIPE_SECRET_KEY ? "stripe" : "demo" });
      }

      if (path === "/api/admin/profile" && request.method === "POST") {
        const staff = me.owner && prac(body.staff) ? body.staff : me.id;
        await store.setBio(staff, String(body.bio ?? "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, 700));
        return json({ ok: true });
      }

      if (path === "/api/admin/photo" && request.method === "POST") {
        const want = url.searchParams.get("staff");
        const staff = me.owner && prac(want) ? want : me.id;
        if (!(request.headers.get("content-type") || "").startsWith("image/jpeg")) return json({ error: "Photo must be a JPEG" }, 400);
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 1_500_000) return json({ error: "Photo is too large" }, 413);
        await store.setPhoto(staff, bytes);
        return json({ ok: true });
      }

      if (path === "/api/admin/day") {
        const date = url.searchParams.get("date") || londonNow().date;
        const h = HOURS[weekday(date)];
        const rows = mine(await store.forDate(date)).map((b) => ({ ...b, time: toTime(b.start), end: toTime(b.start + b.mins), deposit: money(b.deposit) }));
        return json({ date, open: h, practitioners: me.owner ? PRACTITIONERS : [prac(me.id)], bookings: rows, today: londonNow().date });
      }

      if (path === "/api/admin/month") {
        const month = url.searchParams.get("month") || "";
        if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "Bad month" }, 400);
        return json({ counts: await store.monthCounts(month, me.owner ? null : me.id) });
      }

      if (path === "/api/admin/upcoming") {
        const today = londonNow().date;
        const rows = mine(await store.range(today, addDays(today, 90))).filter((b) => b.status === "confirmed")
          .map((b) => ({ ...b, time: toTime(b.start), deposit: money(b.deposit) }));
        return json({ bookings: rows });
      }

      if (path === "/api/admin/cancel" && request.method === "POST") {
        const b = await store.get(clean(body.id, 20));
        if (!b || b.status !== "confirmed" || (!me.owner && b.staff !== me.id)) return json({ error: "Booking not found" }, 404);
        let refunded = false, note = "";
        if (body.refund) {
          if (b.paid_demo) refunded = true;
          else if (env.STRIPE_SECRET_KEY && b.payment_intent) {
            try { await stripe(env, "refunds", { payment_intent: b.payment_intent }); refunded = true; }
            catch (e) { note = `Refund failed: ${e.message}`; }
          }
        }
        await store.cancel(b.id, clean(body.reason, 300), refunded);
        return json({ ok: true, refunded, note });
      }

      if (path === "/api/admin/block" && request.method === "POST") {
        const date = clean(body.date, 10);
        if (!me.owner) body.staff = me.id;
        if (!prac(body.staff) || !isDate(date)) return json({ error: "Pick a practitioner and day" }, 400);
        const h = HOURS[weekday(date)];
        if (!h) return json({ error: "Clinic is closed that day" }, 400);
        const start = body.allDay ? toMin(h.open) : toMin(body.time || "00:00");
        const mins = body.allDay ? toMin(h.close) - toMin(h.open) : Number(body.mins) || 60;
        const r = await store.hold({ treatment: clean(body.reason, 60) || "Blocked", staff: body.staff, date, start, mins, status: "blocked" });
        return r ? json({ ok: true }) : json({ error: "That time overlaps a booking. Cancel it first, or block a shorter time." }, 409);
      }

      if (path === "/api/admin/remove" && request.method === "POST") {
        return (await store.remove(clean(body.id, 20), me.owner ? null : me.id)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
