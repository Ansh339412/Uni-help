import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { randomInt, randomUUID } from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
for (const k of ["DATABASE_URL", "SUPABASE_JWT_SECRET", "SUPABASE_URL", "CLIENT_ORIGIN"])
  if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
app.set("trust proxy", 1);
app.use(helmet(), cors({ origin: process.env.CLIENT_ORIGIN }), express.json({ limit: "20kb" }));
app.use(rateLimit({ windowMs: 15 * 60e3, limit: 600 }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const CATEGORIES = ["Electronics", "Books", "Lab tools", "Chargers", "Other"];
const pin = () => String(randomInt(100000, 1000000));
const uid = (req: Request): string => (req as any).uid;
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "Something went wrong on our side. Try again." });
  });

const auth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    const p = jwt.verify(token, process.env.SUPABASE_JWT_SECRET!, { algorithms: ["HS256"], audience: "authenticated" }) as jwt.JwtPayload;
    const dom = process.env.ALLOWED_EMAIL_DOMAIN;
    if (dom && !String(p.email ?? "").toLowerCase().endsWith("@" + dom.toLowerCase())) return res.status(403).json({ error: "Use your university email." });
    await pool.query("insert into profiles (id, name) values ($1, $2) on conflict do nothing", [
      p.sub,
      "Student " + String(p.sub).slice(0, 4),
    ]);
    (req as any).uid = p.sub;
    next();
  } catch {
    res.status(401).json({ error: "Sign in to continue." });
  }
};

const parseWindow = (a: unknown, b: unknown) => {
  const s = new Date(String(a)), e = new Date(String(b));
  return !isNaN(+s) && !isNaN(+e) && e > s ? [s.toISOString(), e.toISOString()] : null;
};

// Public: community impact numbers. "Purchases avoided" is an estimate: one per completed return.
app.get("/api/stats", h(async (_req, res) => {
  const { rows } = await pool.query(`select
    (select count(*) from items where is_active)::int as items_shared,
    (select count(*) from borrow_requests where status = 'returned')::int as successful_returns,
    (select count(*) from borrow_requests where status in ('pending','confirmed','handed_over'))::int as active_requests`);
  res.json({ ...rows[0], estimated_purchases_avoided: rows[0].successful_returns });
}));

app.use("/api", auth);

app.get("/api/items", h(async (req, res) => {
  const { q, category, from, to } = req.query;
  const w = from && to ? parseWindow(from, to) : null;
  if (from && to && !w) return res.status(400).json({ error: "Pick a valid borrowing window." });
  const { rows } = await pool.query(
    `select i.id, i.title, i.description, i.category, i.image_url, i.location, i.owner_id, p.name as owner_name,
       (select round(avg(v.rating), 1) from reviews v join borrow_requests r on r.id = v.request_id join items x on x.id = r.item_id where x.owner_id = i.owner_id and v.reviewer_id = r.borrower_id) as owner_rating
     from items i join profiles p on p.id = i.owner_id
     where i.is_active
       and ($1::text is null or i.title ilike '%' || $1 || '%')
       and ($2::text is null or i.category = $2)
       and ($3::timestamptz is null or (item_open(i.id, tstzrange($3, $4)) and not exists (
         select 1 from borrow_requests r
         where r.item_id = i.id and r.status in ('confirmed','handed_over')
           and r.period && tstzrange($3, $4))))
     order by i.created_at desc limit 100`,
    [q || null, category || null, w?.[0] ?? null, w?.[1] ?? null]
  );
  res.json(rows);
}));

app.post("/api/items", h(async (req, res) => {
  const { title, description, category, imageUrl } = req.body ?? {};
  if (typeof title !== "string" || !title.trim() || title.length > 100)
    return res.status(400).json({ error: "Give the item a title (up to 100 characters)." });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "Choose a category." });
  if (imageUrl && !String(imageUrl).startsWith(`${process.env.SUPABASE_URL}/storage/v1/object/public/item-images/`))
    return res.status(400).json({ error: "That image isn’t allowed." });
  const { rows } = await pool.query(
    "insert into items (owner_id, title, description, category, image_url, location) values ($1,$2,$3,$4,$5,$6) returning id",
    [uid(req), title.trim(), String(description ?? "").slice(0, 1000), category, imageUrl || null, String(req.body?.location ?? "").slice(0, 60) || null]
  );
  res.status(201).json(rows[0]);
}));

app.delete("/api/items/:id", h(async (req, res) => {
  const r = await pool.query("delete from items where id = $1 and owner_id = $2 and not exists (select 1 from borrow_requests where item_id = items.id and status in ('confirmed','handed_over'))", [req.params.id, uid(req)]);
  r.rowCount ? res.status(204).end() : res.status(404).json({ error: "Item not found, or it’s out on loan right now." });
}));

app.post("/api/requests", h(async (req, res) => {
  const { itemId } = req.body ?? {};
  const w = parseWindow(req.body?.start, req.body?.end);
  if (!w) return res.status(400).json({ error: "Pick a valid borrowing window." });
  const item = await pool.query("select owner_id from items where id = $1 and is_active", [itemId]);
  const pend = await pool.query("select count(*)::int as n from borrow_requests where borrower_id = $1 and status = 'pending'", [uid(req)]);
  if (pend.rows[0].n >= 10) return res.status(429).json({ error: "You have 10 open requests. Wait for replies or cancel some." });
  const open = await pool.query("select item_open($1::uuid, tstzrange($2::timestamptz, $3::timestamptz)) as ok", [itemId, w[0], w[1]]);
  if (!open.rows[0].ok) return res.status(400).json({ error: "The owner isn’t sharing this item for those dates." });
  if (!item.rowCount) return res.status(404).json({ error: "Item not found." });
  if (item.rows[0].owner_id === uid(req)) return res.status(400).json({ error: "You can’t borrow your own item." });
  const { rows } = await pool.query(
    "insert into borrow_requests (item_id, borrower_id, period) values ($1,$2,tstzrange($3,$4,'[)')) returning id",
    [itemId, uid(req), w[0], w[1]]
  );
  res.status(201).json(rows[0]);
}));

// Borrower sees their PINs; owners never do.
app.get("/api/requests", h(async (req, res) => {
  const { rows } = await pool.query(
    `select r.id, r.status, lower(r.period) as start, upper(r.period) as "end", i.title,
       r.borrower_id = $1 as mine,
       case when r.borrower_id = $1 then r.handover_pin end as handover_pin,
       case when r.borrower_id = $1 then r.return_pin end as return_pin
     from borrow_requests r join items i on i.id = r.item_id
     where r.borrower_id = $1 or i.owner_id = $1
     order by r.created_at desc limit 100`,
    [uid(req)]
  );
  res.json(rows);
}));

const ownerUpdate = (set: string, from: string, extra = "") =>
  `update borrow_requests r set ${set} from items i
   where r.id = $1 and i.id = r.item_id and i.owner_id = $2 and r.status = '${from}' ${extra} returning r.id`;

app.post("/api/requests/:id/approve", h(async (req, res) => {
  try {
    const r = await pool.query(ownerUpdate("status = 'confirmed', handover_pin = $3", "pending"), [req.params.id, uid(req), pin()]);
    r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Request not found or already handled." });
  } catch (e: any) {
    if (e.code === "23P01") return res.status(409).json({ error: "These dates overlap a booking you already confirmed." });
    throw e;
  }
}));

app.post("/api/requests/:id/decline", h(async (req, res) => {
  const r = await pool.query(ownerUpdate("status = 'declined'", "pending"), [req.params.id, uid(req)]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Request not found or already handled." });
}));

const pinLimiter = rateLimit({ windowMs: 60e3, limit: 20 });
// After 5 wrong PINs a request locks, so a 6-digit PIN can't be brute-forced.
const pinGuard = (req: Request, res: Response, next: NextFunction) => {
  pool.query("select pin_attempts from borrow_requests where id = $1", [req.params.id]).then((r) => {
    if ((r.rows[0]?.pin_attempts ?? 0) >= 5)
      return res.status(429).json({ error: "Too many wrong PINs. Cancel this request and send a new one." });
    res.on("finish", () => {
      if (res.statusCode === 400) pool.query("update borrow_requests set pin_attempts = pin_attempts + 1 where id = $1", [req.params.id]).catch(console.error);
    });
    next();
  }).catch(next);
};
app.use("/api/requests/:id/:step(handover|return)", pinLimiter, pinGuard);
app.use("/api/requests/:id/messages", rateLimit({ windowMs: 60e3, limit: 30, skip: (r) => r.method !== "POST" }));

app.post("/api/requests/:id/handover", h(async (req, res) => {
  const r = await pool.query(
    ownerUpdate("status = 'handed_over', handed_over_at = now(), return_pin = $4, pin_attempts = 0", "confirmed", "and r.handover_pin = $3"),
    [req.params.id, uid(req), String(req.body?.pin ?? ""), pin()]
  );
  r.rowCount ? res.json({ ok: true }) : res.status(400).json({ error: "That PIN doesn’t match." });
}));

app.post("/api/requests/:id/return", h(async (req, res) => {
  const r = await pool.query(
    ownerUpdate("status = 'returned', returned_at = now()", "handed_over", "and r.return_pin = $3"),
    [req.params.id, uid(req), String(req.body?.pin ?? "")]
  );
  r.rowCount ? res.json({ ok: true }) : res.status(400).json({ error: "That PIN doesn’t match." });
}));

const party = `exists (select 1 from borrow_requests r join items i on i.id = r.item_id
  where r.id = $1::uuid and (r.borrower_id = $2::uuid or i.owner_id = $2::uuid))`;

app.get("/api/requests/:id/messages", h(async (req, res) => {
  const { rows } = await pool.query(
    `select m.id, m.body, m.sender_id = $2::uuid as mine from messages m
     where m.request_id = $1::uuid and ${party} order by m.created_at limit 200`,
    [req.params.id, uid(req)]
  );
  res.json(rows);
}));

app.post("/api/requests/:id/messages", h(async (req, res) => {
  const body = String(req.body?.body ?? "").trim().slice(0, 1000);
  if (!body) return res.status(400).json({ error: "Write a message first." });
  const r = await pool.query(
    `insert into messages (request_id, sender_id, body) select $1::uuid, $2::uuid, $3 where ${party}`,
    [req.params.id, uid(req), body]
  );
  r.rowCount ? res.status(201).json({ ok: true }) : res.status(404).json({ error: "Request not found." });
}));

app.post("/api/requests/:id/review", h(async (req, res) => {
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Choose a rating from 1 to 5." });
  const r = await pool.query(
    `insert into reviews (request_id, reviewer_id, rating, comment)
     select r.id, $2::uuid, $3::int, $4::text from borrow_requests r join items i on i.id = r.item_id
     where r.id = $1::uuid and r.status = 'returned' and (r.borrower_id = $2::uuid or i.owner_id = $2::uuid)
     on conflict do nothing returning id`,
    [req.params.id, uid(req), rating, String(req.body?.comment ?? "").slice(0, 500)]
  );
  r.rowCount ? res.status(201).json({ ok: true }) : res.status(400).json({ error: "You can review a completed loan once." });
}));

// Need It Now: rank free items in the category by each owner's approval history, then ask the top 3 owners.
app.post("/api/need", h(async (req, res) => {
  const { category } = req.body ?? {};
  const hours = Number(req.body?.hours);
  if (!CATEGORIES.includes(category) || !(hours >= 1 && hours <= 72))
    return res.status(400).json({ error: "Choose a category and 1 to 72 hours." });
  const start = new Date(), end = new Date(+start + hours * 3600e3);
  const { rows } = await pool.query(
    `select i.id, i.title from items i
     where i.is_active and i.category = $1 and i.owner_id <> $2::uuid
       and not exists (select 1 from borrow_requests r where r.item_id = i.id
         and r.status in ('confirmed','handed_over') and r.period && tstzrange($3, $4))
       and item_open(i.id, tstzrange($3, $4))
     order by coalesce((i.location = $5::text)::int, 0) desc, coalesce((select avg((x.status <> 'declined')::int) from borrow_requests x
         join items j on j.id = x.item_id where j.owner_id = i.owner_id and x.status <> 'pending'), 0.5) desc,
       i.created_at desc limit 3`,
    [category, uid(req), start.toISOString(), end.toISOString(), String(req.body?.location ?? "") || null]
  );
  const needId = randomUUID();
  for (const it of rows)
    await pool.query("insert into borrow_requests (item_id, borrower_id, period, need_id) values ($1,$2,tstzrange($3,$4,'[)'),$5)",
      [it.id, uid(req), start.toISOString(), end.toISOString(), needId]);
  res.json({ matched: rows.map((r) => r.title) });
}));

const admin = (req: Request, res: Response, next: NextFunction) =>
  pool.query("select is_admin from profiles where id = $1", [uid(req)])
    .then((r) => (r.rows[0]?.is_admin ? next() : res.status(403).json({ error: "Admins only." })))
    .catch(next);

app.get("/api/items/:id/availability", h(async (req, res) => {
  const { rows } = await pool.query(
    `select id, lower(period) as start, upper(period) as "end" from availability_windows where item_id = $1 order by lower(period)`,
    [req.params.id]
  );
  res.json(rows);
}));

app.post("/api/items/:id/availability", h(async (req, res) => {
  const w = parseWindow(req.body?.start, req.body?.end);
  if (!w) return res.status(400).json({ error: "Pick a valid window." });
  const r = await pool.query(
    `insert into availability_windows (item_id, period)
     select i.id, tstzrange($2::timestamptz, $3::timestamptz, '[)') from items i
     where i.id = $1::uuid and i.owner_id = $4::uuid returning id`,
    [req.params.id, w[0], w[1], uid(req)]
  );
  r.rowCount ? res.status(201).json(r.rows[0]) : res.status(404).json({ error: "Item not found." });
}));

app.delete("/api/availability/:id", h(async (req, res) => {
  const r = await pool.query(
    "delete from availability_windows w using items i where w.id = $1 and i.id = w.item_id and i.owner_id = $2",
    [req.params.id, uid(req)]
  );
  r.rowCount ? res.status(204).end() : res.status(404).json({ error: "Window not found." });
}));

app.get("/api/admin/overview", admin, h(async (_req, res) => {
  const s = await pool.query(`select
    (select count(*) from profiles)::int as users,
    (select count(*) from items where is_active)::int as items,
    (select count(*) from borrow_requests)::int as requests,
    (select count(*) from borrow_requests where status = 'returned')::int as returned,
    (select count(*) from borrow_requests where status = 'declined')::int as declined`);
  const recent = await pool.query(
    `select i.id, i.title, p.name as owner_name from items i join profiles p on p.id = i.owner_id
     where i.is_active order by i.created_at desc limit 50`
  );
  res.json({ ...s.rows[0], recent: recent.rows });
}));

app.delete("/api/admin/items/:id", admin, h(async (req, res) => {
  await pool.query("update items set is_active = false where id = $1", [req.params.id]);
  res.status(204).end();
}));

app.post("/api/requests/:id/cancel", h(async (req, res) => {
  const r = await pool.query(
    `update borrow_requests r set status = 'cancelled' from items i
     where r.id = $1::uuid and i.id = r.item_id and (r.borrower_id = $2::uuid or i.owner_id = $2::uuid)
       and r.status in ('pending','confirmed') returning r.id`,
    [req.params.id, uid(req)]
  );
  r.rowCount ? res.json({ ok: true }) : res.status(400).json({ error: "This request can’t be cancelled any more." });
}));

app.patch("/api/me", h(async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (name.length < 1 || name.length > 40) return res.status(400).json({ error: "Use 1 to 40 characters." });
  await pool.query("update profiles set name = $2 where id = $1", [uid(req), name]);
  res.json({ ok: true });
}));

app.listen(Number(process.env.PORT) || 4000, () => console.log("CIRCLEND API ready"));
