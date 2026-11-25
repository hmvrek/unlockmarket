import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
  stripeSessionId: text('stripe_session_id'),
  paymentStatus: text('payment_status').notNull().default('unpaid'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
}, (table) => [
  check('order_total_positive', sql`${table.totalGrosz} > 0`),
  check('orders_payment_status_check', sql`${table.paymentStatus} in ('unpaid', 'paid', 'failed', 'expired')`),
  index('orders_created_at_idx').on(table.createdAt),
  uniqueIndex('orders_stripe_session_unique_idx').on(table.stripeSessionId)
    .where(sql`${table.stripeSessionId} is not null`),
])

export const activationCodes = pgTable('activation_codes', {
  id: uuid().defaultRandom().primaryKey(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  code: text().notNull(),
  codeHash: text('code_hash').notNull(),
  reservedOrderId: uuid('reserved_order_id'),
  reservationExpiresAt: timestamp('reservation_expires_at', { withTimezone: true }),
  orderId: uuid('order_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('activation_code_reservation_pair', sql`(${table.reservedOrderId} is null) = (${table.reservationExpiresAt} is null)`),
  check('activation_code_not_reserved_and_sold', sql`${table.reservedOrderId} is null or ${table.orderId} is null`),
  uniqueIndex('activation_codes_code_hash_unique_idx').on(table.codeHash),
  index('activation_codes_product_available_idx').on(table.productId, table.createdAt)
    .where(sql`${table.orderId} is null`),
  index('activation_codes_reservation_idx').on(table.reservedOrderId)
    .where(sql`${table.reservedOrderId} is not null`),
])
