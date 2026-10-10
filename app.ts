import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { neon } from '@neondatabase/serverless';
import { z } from 'zod';
import { CATALOG_KINDS, selectColumn } from './catalog.js';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return value;
};

// Same Neon database ambi-client uses; this server is the only admin writer.
const sql = neon(requireEnv('DATABASE_URL'));
const ADMIN_PASSWORD = requireEnv('ADMIN_PASSWORD');
const PORT: number = Number(process.env.PORT) || 4100;
// Comma-separated list of admin client origins allowed to call this API.
const ALLOWED_ORIGINS = (process.env.ADMIN_CLIENT_ORIGIN || 'http://localhost:3100')
  .split(',')
  .map((origin) => origin.trim());

const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Auth ------------------------------------------------------------------
// One admin (the platform owner), one shared password. The client sends it as
// a bearer token on every request. Hashing both sides first gives equal-length
// buffers so timingSafeEqual can compare without leaking the length.
const digest = (value: string) => createHash('sha256').update(value).digest();
const ADMIN_PASSWORD_DIGEST = digest(ADMIN_PASSWORD);

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const token = req.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!timingSafeEqual(digest(token), ADMIN_PASSWORD_DIGEST)) {
    return res.status(401).json({ error: 'Wrong admin password.' });
  }
  next();
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', requireAdmin);

// Lets the client check a password at sign-in without loading data.
app.post('/api/session', (_req, res) => {
  res.json({ ok: true });
});

// Validation ------------------------------------------------------------
const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
] as const;

const requiredText = z.string().trim().min(1);

// The full editable "basics" of a business. PUT replaces all of it, so the
// client always sends the whole form.
const optionalText = z.string().trim().transform((value) => value || null);

const businessSchema = z.object({
  name: requiredText,
  // Shown in the install flow's header; empty shows the name instead.
  logo_url: z
    .union([z.url({ protocol: /^https$/, error: 'Use an https:// image URL' }), z.literal('')])
    .transform((value) => value || null),
  // 'basic' sells the headliner/ambient package/add-on menu; 'custom' sells the
  // business's own package tiers. See ambi-client/db/006_custom_packages.sql.
  sales_type: z.enum(['basic', 'custom']),
  description: z.string().trim().max(1000),
  // The warranty name and price are kept when the offer is switched off, so
  // turning it back on doesn't lose them.
  contains_warranty: z.boolean(),
  warranty_name: optionalText,
  warranty_price: z.union([z.literal(''), z.null(), z.coerce.number().min(0)]).transform((value) =>
    value === '' ? null : value,
  ),
  // 'in_app': the lights are recolored from a Bluetooth app after install, so
  // the install flow shows a note instead of a color picker. The business's
  // color rows are kept either way. See ambi-client/db/009_color_selection.sql.
  color_selection: z.enum(['at_booking', 'in_app']),
  // Where new-request notifications go; empty means the business isn't emailed.
  email: z.union([z.email(), z.literal('')]).transform((value) => value || null),
  // Which installs the business offers; the travel fee only applies to mobile ones.
  service_modes: z.enum(['shop', 'mobile', 'both']),
  travel_fee_value: z.coerce.number().min(0),
  soonest_start_days_in_advance: z.coerce.number().int().min(0),
  address: z.object({
    street_address: requiredText,
    extended_address: z.string().trim().transform((value) => value || null),
    city: requiredText,
    state: z.enum(US_STATES),
    postal_code: z.string().trim().regex(/^[0-9]{5}(-[0-9]{4})?$/, 'Use a 5-digit ZIP'),
  }),
  owner: z.object({
    first_name: requiredText,
    last_name: requiredText,
    phone: requiredText,
    email: z.email(),
  }),
}).refine((b) => !b.contains_warranty || (b.warranty_name !== null && b.warranty_price !== null), {
  message: 'A warranty needs a name and a price',
  path: ['warranty_name'],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are typed loosely by Express; this narrows and checks the uuid. */
const idParam = (req: Request, name: string): string | null => {
  const value = req.params[name];
  return typeof value === 'string' && UUID.test(value) ? value : null;
};

const badRequest = (res: Response, error: z.ZodError) =>
  res.status(400).json({
    error: error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; '),
  });

// Businesses ------------------------------------------------------------
app.get('/api/businesses', async (_req, res) => {
  const rows = await sql`
    select b.id, b.name, b.email, a.city, a.state, b.created_at,
           (select count(*)::int from installation_request r where r.business_id = b.id) as request_count
    from business b
    join address a on a.id = b.business_address_id
    order by b.name`;
  res.json(rows);
});

app.get('/api/businesses/:id', async (req, res) => {
  const id = idParam(req, 'id');
  if (!id) return res.status(404).json({ error: 'Business not found.' });

  const [business] = await sql`
    select b.id, b.name, coalesce(b.logo_url, '') as logo_url, coalesce(b.email, '') as email, b.service_modes,
           b.travel_fee_value::float8 as travel_fee_value, b.soonest_start_days_in_advance,
           b.sales_type, b.description, coalesce(b.contains_warranty, false) as contains_warranty,
           coalesce(b.warranty_name, '') as warranty_name, b.warranty_price::float8 as warranty_price,
           b.color_selection, b.created_at,
           b.closed_weekdays::int[] as closed_weekdays,
           coalesce(to_char(b.full_day_drop_off_time, 'HH24:MI'), '') as full_day_drop_off_time,
           json_build_object(
             'street_address', a.street_address,
             'extended_address', coalesce(a.extended_address, ''),
             'city', a.city, 'state', a.state, 'postal_code', a.postal_code
           ) as address,
           json_build_object(
             'first_name', c.first_name, 'last_name', c.last_name,
             'phone', c.phone, 'email', c.email
           ) as owner
    from business b
    join address a on a.id = b.business_address_id
    join customer c on c.id = b.business_owner_customer_id
    where b.id = ${id}`;
  if (!business) return res.status(404).json({ error: 'Business not found.' });

  const catalog: Record<string, unknown[]> = {};
  await Promise.all(
    Object.entries(CATALOG_KINDS).map(async ([kind, config]) => {
      catalog[kind] = await sql.query(
        `select id, ${config.columns.map(selectColumn).join(', ')}
         from ${config.table} where business_id = $1 order by ${config.orderBy}`,
        [id],
      );
    }),
  );
  res.json({ ...business, catalog });
});

app.post('/api/businesses', async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { address, owner, ...business } = parsed.data;

  // Neon's HTTP transactions can't read one statement's RETURNING in the next,
  // so ids are generated here and the three inserts run as one batch.
  const addressId = randomUUID();
  const ownerId = randomUUID();
  const businessId = randomUUID();
  await sql.transaction([
    sql`insert into address (id, street_address, extended_address, city, state, postal_code)
        values (${addressId}, ${address.street_address}, ${address.extended_address},
                ${address.city}, ${address.state}, ${address.postal_code})`,
    sql`insert into customer (id, first_name, last_name, address_id, phone, email)
        values (${ownerId}, ${owner.first_name}, ${owner.last_name}, ${addressId},
                ${owner.phone}, ${owner.email})`,
    sql`insert into business (id, business_owner_customer_id, name, email, business_address_id,
                              service_modes, travel_fee_value, soonest_start_days_in_advance,
                              sales_type, description, contains_warranty, warranty_name, warranty_price,
                              color_selection, logo_url)
        values (${businessId}, ${ownerId}, ${business.name}, ${business.email}, ${addressId},
                ${business.service_modes}, ${business.travel_fee_value},
                ${business.soonest_start_days_in_advance},
                ${business.sales_type}, ${business.description}, ${business.contains_warranty},
                ${business.warranty_name}, ${business.warranty_price},
                ${business.color_selection}, ${business.logo_url})`,
  ]);
  res.status(201).json({ id: businessId });
});

app.put('/api/businesses/:id', async (req, res) => {
  const id = idParam(req, 'id');
  if (!id) return res.status(404).json({ error: 'Business not found.' });
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { address, owner, ...business } = parsed.data;

  const [updated] = await sql.transaction([
    sql`update business set name = ${business.name}, email = ${business.email},
          service_modes = ${business.service_modes},
          travel_fee_value = ${business.travel_fee_value},
          soonest_start_days_in_advance = ${business.soonest_start_days_in_advance},
          sales_type = ${business.sales_type}, description = ${business.description},
          contains_warranty = ${business.contains_warranty},
          warranty_name = ${business.warranty_name}, warranty_price = ${business.warranty_price},
          color_selection = ${business.color_selection},
          logo_url = ${business.logo_url}
        where id = ${id} returning id`,
    sql`update address set street_address = ${address.street_address},
          extended_address = ${address.extended_address}, city = ${address.city},
          state = ${address.state}, postal_code = ${address.postal_code}
        where id = (select business_address_id from business where id = ${id})`,
    sql`update customer set first_name = ${owner.first_name}, last_name = ${owner.last_name},
          phone = ${owner.phone}, email = ${owner.email}
        where id = (select business_owner_customer_id from business where id = ${id})`,
  ]);
  if (!updated?.length) return res.status(404).json({ error: 'Business not found.' });
  res.json({ id });
});

app.delete('/api/businesses/:id', async (req, res) => {
  const id = idParam(req, 'id');
  if (!id) return res.status(404).json({ error: 'Business not found.' });

  const [usage] = await sql`
    select count(*)::int as count from installation_request where business_id = ${id}`;
  if (usage && usage.count > 0) {
    return res.status(409).json({
      error: `This business has ${usage.count} install request(s), so it can't be deleted.`,
    });
  }
  // Catalog rows cascade. Then the owner and address go too, unless
  // something else (another business, a request, a customer) still uses them.
  const [deleted] = await sql`
    delete from business where id = ${id}
    returning business_owner_customer_id as owner_id, business_address_id as address_id`;
  if (!deleted) return res.status(404).json({ error: 'Business not found.' });
  await sql`
    delete from customer c where c.id = ${deleted.owner_id}
      and not exists (select 1 from business b where b.business_owner_customer_id = c.id)
      and not exists (select 1 from installation_request r where r.customer_id = c.id)`;
  await sql`
    delete from address a where a.id = ${deleted.address_id}
      and not exists (select 1 from business b where b.business_address_id = a.id)
      and not exists (select 1 from customer c where c.address_id = a.id)`;
  res.status(204).end();
});

// Schedule ---------------------------------------------------------------
// Weekly closed days and the full-day drop-off time. Blocks and closed
// dates are catalog kinds (catalog.ts). See ambi-client/db/016.
const scheduleSchema = z.object({
  closed_weekdays: z.array(z.number().int().min(0).max(6)).max(7).transform((days) => [...new Set(days)].sort()),
  // '' means the first block's start time.
  full_day_drop_off_time: z
    .union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30')])
    .transform((value) => value || null),
});

app.put('/api/businesses/:id/schedule', async (req, res) => {
  const id = idParam(req, 'id');
  if (!id) return res.status(404).json({ error: 'Business not found.' });
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);

  const [updated] = await sql`
    update business
    set closed_weekdays = ${parsed.data.closed_weekdays}::smallint[],
        full_day_drop_off_time = ${parsed.data.full_day_drop_off_time}
    where id = ${id} returning id`;
  if (!updated) return res.status(404).json({ error: 'Business not found.' });
  res.json({ id });
});

// Install requests (read-only) ------------------------------------------
app.get('/api/businesses/:id/requests', async (req, res) => {
  const id = idParam(req, 'id');
  if (!id) return res.status(404).json({ error: 'Business not found.' });

  const rows = await sql`
    select r.id, r.status, r.created_at, r.selected_installation_method,
           r.preferred_date_start_time, r.preferred_date_end_time, r.install_days,
           c.first_name, c.last_name, c.email, c.phone,
           v.year, v.make, v.model,
           q.total::float8 as quote_total
    from installation_request r
    join customer c on c.id = r.customer_id
    join vehicle v on v.id = r.selected_vehicle_id
    left join quote q on q.installation_request_id = r.id
    where r.business_id = ${id}
    order by r.created_at desc
    limit 200`;
  res.json(rows);
});

// Catalog ---------------------------------------------------------------
app.post('/api/businesses/:id/catalog/:kind', async (req, res) => {
  const id = idParam(req, 'id');
  const config = CATALOG_KINDS[String(req.params.kind)];
  if (!id || !config) return res.status(404).json({ error: 'Not found.' });
  const parsed = config.schema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);

  const values = config.columns.map((column) => parsed.data[column]);
  const placeholders = config.columns.map((_, i) => `$${i + 2}`).join(', ');
  const [row] = await sql.query(
    `insert into ${config.table} (business_id, ${config.columns.join(', ')})
     values ($1, ${placeholders})
     returning id, ${config.columns.map(selectColumn).join(', ')}`,
    [id, ...values],
  );
  res.status(201).json(row);
});

app.patch('/api/businesses/:id/catalog/:kind/:itemId', async (req, res) => {
  const id = idParam(req, 'id');
  const itemId = idParam(req, 'itemId');
  const config = CATALOG_KINDS[String(req.params.kind)];
  if (!id || !itemId || !config) return res.status(404).json({ error: 'Not found.' });
  const parsed = config.schema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);

  const columns = config.columns.filter((column) => parsed.data[column] !== undefined);
  if (!columns.length) return res.status(400).json({ error: 'Nothing to update.' });
  const assignments = columns.map((column, i) => `${column} = $${i + 3}`).join(', ');
  const [row] = await sql.query(
    `update ${config.table} set ${assignments}
     where id = $1 and business_id = $2
     returning id, ${config.columns.map(selectColumn).join(', ')}`,
    [itemId, id, ...columns.map((column) => parsed.data[column])],
  );
  if (!row) return res.status(404).json({ error: 'Item not found.' });
  res.json(row);
});

app.delete('/api/businesses/:id/catalog/:kind/:itemId', async (req, res) => {
  const id = idParam(req, 'id');
  const itemId = idParam(req, 'itemId');
  const config = CATALOG_KINDS[String(req.params.kind)];
  if (!id || !itemId || !config) return res.status(404).json({ error: 'Not found.' });

  const deleted = await sql.query(
    `delete from ${config.table} where id = $1 and business_id = $2 returning id`,
    [itemId, id],
  );
  if (!deleted.length) return res.status(404).json({ error: 'Item not found.' });
  res.status(204).end();
});

// Errors ----------------------------------------------------------------
// Express 5 forwards rejected async handlers here. Postgres constraint errors
// become readable 4xx messages; anything else is a 500.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code = (err as { code?: string }).code;
  if (code === '23505') {
    return res.status(409).json({ error: 'That already exists for this business.' });
  }
  if (code === '23503' && (err as { constraint?: string }).constraint === 'schedule_hold_block_id_fkey') {
    return res.status(409).json({
      error: "Requests are holding this block, so it can't be deleted. Change its times instead, or delete it once they're past.",
    });
  }
  if (code === '23503') {
    return res.status(409).json({
      error: "It's used by existing install requests, so it can't be deleted. Change its price instead.",
    });
  }
  if ((err as { constraint?: string }).constraint === 'schedule_block_ordered') {
    return res.status(400).json({ error: 'A block has to end after it starts.' });
  }
  if ((err as { constraint?: string }).constraint === 'starlight_add_on_price_sign') {
    return res.status(400).json({
      error: 'No twinkle is a discount, so enter it as 0 or a negative price (e.g. -80). Other starlight add-ons can\'t be negative.',
    });
  }
  if (code === '23514' || code === '22P02') {
    return res.status(400).json({ error: 'That value is not allowed.' });
  }
  console.error('Admin API error:', err);
  res.status(500).json({ error: 'Something went wrong on the admin server.' });
});

// On Vercel the default export is run as a serverless function, so there's
// no port to listen on; locally (npm run dev) it's a normal server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Admin server is running on http://localhost:${PORT}`);
  });
}

export default app;
