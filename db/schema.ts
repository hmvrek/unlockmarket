import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const category = pgEnum('product_category', ['license', 'addon', 'other'])
export const status = pgEnum('order_status', ['new', 'confirmed', 'completed', 'cancelled'])

export const products = pgTable('products', {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  category: category().notNull(),
  priceGrosz: integer('price_grosz').notNull(),
  published: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('product_price_range', sql`${table.priceGrosz} between 1 and 999999`),
  index('products_catalog_idx').on(table.published, table.createdAt),
])

export const orders = pgTable('orders', {
  id: uuid().primaryKey(),
  email: text().notNull(),
  items: jsonb().$type<Array<{ id: string; name: string; priceGrosz: number; quantity: number }>>().notNull(),
  totalGrosz: integer('total_grosz').notNull(),
  status: status().notNull().default('new'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('order_total_positive', sql`${table.totalGrosz} > 0`),
  index('orders_created_at_idx').on(table.createdAt),
])
