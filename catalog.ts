import { z } from 'zod';

// Enum values must match the Postgres enums in ambi-client/db/001_schema.sql.
export const ADD_ON_KINDS = ['handles', 'storage', 'footwell', 'extraDashStrip'] as const;
export const COLOR_NAMES = ['red', 'blue', 'green', 'violet'] as const;
// ambi-client/db/010_starlight_add_ons.sql
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

interface CatalogKind {
  table: string;
  /** Columns returned to the client, in display order. `id` is always included. */
  columns: string[];
  /** Validates a create body; an update accepts any subset (`.partial()`). */
  schema: z.ZodObject<z.ZodRawShape>;
  /** Ordering for list output. */
  orderBy: string;
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
    columns: ['name', 'price', 'description'],
    schema: z.object({
      name: z.string().trim().min(1).max(80),
      price: money,
      description: z.string().trim().max(500),
    }),
    orderBy: 'price, name',
  },
  headliner: {
    table: 'starlight_headliner_package',
    columns: ['quantity', 'price'],
    schema: z.object({ quantity: positiveInt, price: money }),
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
  },
  door: {
    table: 'door_lighting_package',
    columns: ['quantity', 'price'],
    schema: z.object({ quantity: positiveInt, price: money }),
    orderBy: 'quantity',
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
};

/** numeric columns come back from Postgres as strings; cast them for the client. */
export const selectColumn = (column: string) =>
  column === 'price' || column === 'percentage' ? `${column}::float8 as ${column}` : column;
