import { z } from 'zod';

// Enum values must match the Postgres enums in ambi-client/db/001_schema.sql.
export const ADD_ON_KINDS = ['handles', 'storage', 'footwell', 'extraDashStrip', 'speakerRingLights'] as const;
export const COLOR_NAMES = ['red', 'blue', 'green', 'violet'] as const;
// ambi-client/db/010_starlight_add_ons.sql. A business's own add-ons
// (db/017) are free-text names in the same table, marked custom.
export const STARLIGHT_ADD_ON_KINDS = [
  'sunroof',
  'dualColorStars',
  'shootingStars',
  'customDesigns',
  'noTwinkle',
] as const;

const money = z.coerce.number().min(0).max(99_999_999.99);
// Starlight add-on prices can be negative: noTwinkle is a discount. Which
// sign goes with which add-on is the database's check (see app.ts errors).
const signedMoney = z.coerce.number().min(-99_999_999.99).max(99_999_999.99);
// Form values arrive as 'true'/'false' strings; z.coerce.boolean would read
// 'false' as true.
const flag = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);
// Consecutive days an install takes (db/012); matches the database's 1–14 check.
const installDays = z.coerce.number().int().min(1).max(14);
// How many of an add-on a package includes, up to that add-on's limit
// (ADD_ON_MAX_QUANTITY in ambi-client/lib/pricing.ts). No .default(0): under
// the PATCH route's .partial() it would reset quantities that weren't sent.
const includedQuantity = (max: number) => z.coerce.number().int().min(0).max(max);
// How much of the business's day a package takes (ambi-client/db/016).
const duration = z.enum(['block', 'full_day']);
// "09:00" or "13:30", as an <input type="time"> sends it.
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-25');

interface CatalogKind {
  table: string;
  /** Columns returned to the client, in display order. `id` is always included. */
  columns: string[];
  /** Validates a create body; an update accepts any subset (`.partial()`). */
  schema: z.ZodObject<z.ZodRawShape>;
  /** Ordering for list output. */
  orderBy: string;
  /**
   * For two kinds sharing a table: a boolean column that must equal `value`.
   * Lists, updates and deletes only see matching rows, and inserts set it.
   */
  scope?: { column: string; value: boolean };
}

/**
 * The per-business catalog tables, keyed by the URL segment used in
 * /api/businesses/:id/catalog/:kind. Table and column names are only ever
 * taken from this whitelist, never from the request, so building SQL text
 * from them is safe.
 */
export const CATALOG_KINDS: Record<string, CatalogKind> = {
  // Only used by 'custom' businesses (see business.sales_type in db/006).
  customTier: {
    table: 'custom_package_tier',
    columns: ['name', 'price', 'duration', 'description'],
    schema: z.object({
      name: z.string().trim().min(1).max(80),
      price: money,
      duration,
      description: z.string().trim().max(500),
    }),
    orderBy: 'price, name',
  },
  headliner: {
    table: 'starlight_headliner_package',
    columns: ['quantity', 'price', 'duration', 'install_days'],
    schema: z.object({ quantity: positiveInt, price: money, duration, install_days: installDays }),
    orderBy: 'quantity',
  },
  // On/off extras for a headliner. is_starting_price shows the price as "From $X".
  starlightAddOn: {
    table: 'starlight_add_on_package',
    columns: ['name', 'price', 'is_starting_price'],
    schema: z.object({
      name: z.enum(STARLIGHT_ADD_ON_KINDS),
      price: signedMoney,
      is_starting_price: flag,
    }),
    orderBy: 'name',
    scope: { column: 'custom', value: false },
  },
  // The business's own starlight add-ons, shown with the built-in ones. Any
  // price sign, so a discount works too.
  customStarlightAddOn: {
    table: 'starlight_add_on_package',
    columns: ['name', 'price', 'is_starting_price', 'description'],
    schema: z.object({
      name: z.string().trim().min(1).max(60),
      price: signedMoney,
      is_starting_price: flag,
      description: z.string().trim().max(300),
    }),
    orderBy: 'name',
    scope: { column: 'custom', value: true },
  },
  // Ambient lighting packages for 'basic' businesses (db/013), with the
  // add-ons each one already includes (db/015).
  ambientPackage: {
    table: 'ambient_lighting_package',
    columns: [
      'name',
      'price',
      'duration',
      'description',
      'included_handles',
      'included_storage',
      'included_footwell',
      'included_extra_dash_strip',
      'included_speaker_ring_lights',
    ],
    schema: z.object({
      name: z.string().trim().min(1).max(80),
      price: money,
      duration,
      description: z.string().trim().max(500),
      included_handles: includedQuantity(4),
      included_storage: includedQuantity(4),
      included_footwell: includedQuantity(6),
      included_extra_dash_strip: includedQuantity(20),
      included_speaker_ring_lights: includedQuantity(20),
    }),
    orderBy: 'price, name',
  },
  addOn: {
    table: 'add_on_package',
    columns: ['name', 'price'],
    schema: z.object({ name: z.enum(ADD_ON_KINDS), price: money }),
    orderBy: 'name',
  },
  color: {
    table: 'color_option',
    columns: ['name'],
    schema: z.object({ name: z.enum(COLOR_NAMES) }),
    orderBy: 'name',
  },
  rush: {
    table: 'expedited_pricing_rule',
    columns: ['percentage', 'days_in_advance'],
    schema: z.object({ percentage: z.coerce.number().min(0).max(999.99), days_in_advance: nonNegativeInt }),
    orderBy: 'days_in_advance',
  },
  // Extra % for a drop-off on a weekday (ambi-client/db/017); stacks with rush.
  weekdaySurcharge: {
    table: 'weekday_surcharge',
    columns: ['weekday', 'percentage'],
    schema: z.object({
      weekday: z.coerce.number().int().min(0).max(6),
      percentage: z.coerce.number().positive().max(999.99),
    }),
    orderBy: 'weekday',
  },
  // The fixed parts of a business's day (ambi-client/db/016). Adding the
  // first one turns on held times and Confirm/Decline for the business.
  scheduleBlock: {
    table: 'schedule_block',
    columns: ['label', 'start_time', 'end_time'],
    schema: z.object({ label: z.string().trim().min(1).max(40), start_time: clockTime, end_time: clockTime }),
    orderBy: 'start_time',
  },
  closedDate: {
    table: 'schedule_closed_date',
    columns: ['day'],
    schema: z.object({ day: isoDate }),
    orderBy: 'day',
  },
};

/** The scope's SQL condition, ANDed onto a query's where clause ('' without one). */
export const scopeCondition = (config: CatalogKind) =>
  config.scope ? ` and ${config.scope.column} = ${config.scope.value}` : '';

/**
 * numeric columns come back from Postgres as strings, so they're cast for
 * the client; times and dates are formatted the way their inputs take them.
 */
export const selectColumn = (column: string) => {
  if (column === 'price' || column === 'percentage') return `${column}::float8 as ${column}`;
  if (column === 'start_time' || column === 'end_time') return `to_char(${column}, 'HH24:MI') as ${column}`;
  if (column === 'day') return `to_char(day, 'YYYY-MM-DD') as day`;
  return column;
};
