import { createHash } from 'node:crypto'
import { getIdentityConfig } from '@netlify/identity'
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie } from 'hono/cookie'
import { db } from '../../db/index.ts'
import { activationCodes, category, orders, products, status } from '../../db/schema.ts'
import Stripe from 'stripe'

const app = new Hono()
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const pageSize = 24

function error(context, statusCode, message) {
  return context.json({ error: message }, statusCode)
}

function productInput(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const description = typeof input?.description === 'string' ? input.description.trim() : ''
  if (name.length < 2 || name.length > 100 || description.length < 10 || description.length > 1600 ||
    !category.enumValues.includes(input?.category) || typeof input?.published !== 'boolean' ||
    !Number.isInteger(input?.priceGrosz) || input.priceGrosz < 1 || input.priceGrosz > 999999) return null
  return { name, description, category: input.category, priceGrosz: input.priceGrosz, published: input.published }
}

function orderInput(input) {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (typeof input?.id !== 'string' || !uuid.test(input.id) || email.length > 254 ||
    !emailPattern.test(email) || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10) return null
  const quantities = new Map()
  for (const item of input.items) {
    if (typeof item?.id !== 'string' || !uuid.test(item.id) || !Number.isInteger(item.quantity) ||
      item.quantity < 1 || item.quantity > 10) return null
    const id = item.id.toLowerCase()
    if (quantities.has(id)) return null
    quantities.set(id, item.quantity)
  }
  return { id: input.id.toLowerCase(), email, quantities }
}

function getStripe() {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret) throw new Error('Stripe is not configured.')
  return new Stripe(secret)
}

function activationCodeHash(code) {
  return createHash('sha256').update(code.toUpperCase()).digest('hex')
}

function parseActivationCodes(input) {
  if (typeof input?.codes !== 'string' || input.codes.length > 512 * 1024) return null
  const lines = input.codes.split(/\r?\n/).map((code) => code.trim()).filter(Boolean)
  if (!lines.length || lines.length > 500 || lines.some((code) =>
    code.length < 4 || code.length > 256 || /[\u0000-\u001f\u007f]/.test(code))) return null
  return [...new Map(lines.map((code) => [activationCodeHash(code), code])).values()]
}

class InventoryUnavailableError extends Error {}
class CheckoutInProgressError extends Error {}

async function releaseReservation(orderId, paymentStatus) {
  await db.transaction(async (transaction) => {
    await transaction.update(activationCodes).set({
      reservedOrderId: null,
      reservationExpiresAt: null,
    }).where(eq(activationCodes.reservedOrderId, orderId))
    await transaction.update(orders).set({ paymentStatus, status: 'cancelled' })
      .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, 'unpaid')))
  })
}

async function fulfillPaidOrder(session) {
  const orderId = session?.metadata?.order_id
  if (!uuid.test(orderId ?? '') || session.mode !== 'payment' || session.status !== 'complete' ||
    session.payment_status !== 'paid' || session.currency !== 'pln') return null

  return db.transaction(async (transaction) => {
    const [order] = await transaction.select().from(orders).where(eq(orders.id, orderId)).for('update')
    if (!order || order.stripeSessionId !== session.id || session.client_reference_id !== orderId ||
      order.totalGrosz !== session.amount_total || !Array.isArray(order.items)) return null

    const expectedCount = order.items.reduce((total, item) => total + item.quantity, 0)
    if (order.paymentStatus !== 'paid') {
      const reserved = await transaction.select({ id: activationCodes.id }).from(activationCodes)
        .where(and(eq(activationCodes.reservedOrderId, orderId), isNull(activationCodes.orderId)))
        .for('update')
      if (reserved.length !== expectedCount) {
        await transaction.update(orders).set({
          paymentStatus: 'paid',
          status: 'confirmed',
          paidAt: sql`COALESCE(${orders.paidAt}, now())`,
        }).where(eq(orders.id, orderId))
        return { missing: true, codes: [] }
      }
      await transaction.update(activationCodes).set({
        orderId,
        reservedOrderId: null,
        reservationExpiresAt: null,
      }).where(eq(activationCodes.reservedOrderId, orderId))
      await transaction.update(orders).set({
        paymentStatus: 'paid',
        status: 'confirmed',
        paidAt: sql`COALESCE(${orders.paidAt}, now())`,
      }).where(eq(orders.id, orderId))
    }

    const delivered = await transaction.select({
      productId: activationCodes.productId,
      code: activationCodes.code,
      name: products.name,
    }).from(activationCodes)
      .innerJoin(products, eq(activationCodes.productId, products.id))
      .where(eq(activationCodes.orderId, orderId))
      .orderBy(asc(activationCodes.createdAt), asc(activationCodes.id))
    return {
      missing: delivered.length !== expectedCount,
      codes: delivered.map(({ productId, name, code }) => ({ productId, name, code })),
    }
  })
}

async function attachStock(records) {
  if (!records.length) return records
  const stockRows = await db.select({
    productId: activationCodes.productId,
    availableCodes: count(),
  }).from(activationCodes)
    .where(and(
      inArray(activationCodes.productId, records.map(({ id }) => id)),
      isNull(activationCodes.orderId),
      isNull(activationCodes.reservedOrderId),
    ))
    .groupBy(activationCodes.productId)
  const stock = new Map(stockRows.map(({ productId, availableCodes }) => [productId, availableCodes]))
  return records.map((record) => ({ ...record, availableCodes: stock.get(record.id) ?? 0 }))
}

async function readPage(table, context, where) {
  const query = context.req.query('page') || '1'
  if (!/^[1-9]\d{0,3}$/.test(query)) return error(context, 400, 'Nieprawidłowy numer strony.')
  const page = Number(query)
  const rows = await db.select().from(table).where(where).orderBy(desc(table.createdAt), desc(table.id))
    .offset((page - 1) * pageSize).limit(pageSize + 1)
  const pageRecords = rows.slice(0, pageSize)
  const records = table === products ? await attachStock(pageRecords) : pageRecords
  return context.json({ records, hasMore: rows.length > pageSize })
}

app.use('/api/*', async (context, next) => {
  context.header('Cache-Control', 'no-store')
  context.header('X-Content-Type-Options', 'nosniff')
  if (['POST', 'PATCH'].includes(context.req.method)) {
    const isStripeWebhook = context.req.path === '/api/stripe/webhook'
    const origin = context.req.header('Origin')
    if (!isStripeWebhook && origin !== new URL(context.req.url).origin) {
      return error(context, 403, 'Niedozwolone źródło żądania.')
    }
    if (context.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return error(context, 415, 'Oczekiwano danych JSON.')
    }
  }
  await next()
})

app.use('/api/*', bodyLimit({
  maxSize: 512 * 1024,
  onError: (context) => error(context, 413, 'Przesłane dane są za duże.'),
}))

app.use('/api/admin/*', async (context, next) => {
  const token = getCookie(context, 'nf_jwt')
  if (!token || token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    return error(context, 401, 'Zaloguj się do panelu.')
  }

  const siteUrl = context.env?.siteUrl || process.env.URL
  const identityUrl = getIdentityConfig()?.url || (siteUrl && new URL('/.netlify/identity', siteUrl).href)
  if (!identityUrl) return error(context, 503, 'Logowanie jest chwilowo niedostępne.')
  const result = await fetch(new URL('user', `${identityUrl.replace(/\/$/, '')}/`), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  }).catch(() => null)
  if (result?.status === 401 || result?.status === 403) return error(context, 401, 'Zaloguj się ponownie.')
  if (!result?.ok) return error(context, 503, 'Logowanie jest chwilowo niedostępne.')
  const identity = await result.json().catch(() => null)
  if (!identity?.id || !Array.isArray(identity.app_metadata?.roles) || !identity.app_metadata.roles.includes('admin')) {
    return error(context, 403, 'To konto nie ma uprawnień administratora.')
  }
  await next()
})

app.get('/api/products', (context) => {
  const filter = context.req.query('category')
  const search = context.req.query('q')?.trim().slice(0, 100)
  if (filter && !category.enumValues.includes(filter)) return error(context, 400, 'Nieznana kategoria.')
  const pattern = search && `%${search.replace(/[\\%_]/g, '\\$&')}%`
  return readPage(products, context, and(
    eq(products.published, true),
    filter ? eq(products.category, filter) : undefined,
    pattern ? or(ilike(products.name, pattern), ilike(products.description, pattern)) : undefined,
  ))
})

app.get('/api/products/:id', async (context) => {
  const id = context.req.param('id')
  if (!uuid.test(id)) return error(context, 404, 'Nie znaleziono produktu.')
  const [product] = await db.select().from(products).where(and(eq(products.id, id), eq(products.published, true)))
  if (!product) return error(context, 404, 'Nie znaleziono produktu.')
  return context.json((await attachStock([product]))[0])
})

app.post('/api/checkout', async (context) => {
  const input = await context.req.json().catch(() => null)
  const order = orderInput(input)
  if (!order || (typeof input.website === 'string' && input.website.trim())) {
    return error(context, 400, 'Sprawdź adres e-mail i produkty w koszyku.')
  }

  const [existing] = await db.select({
    email: orders.email,
    stripeSessionId: orders.stripeSessionId,
    paymentStatus: orders.paymentStatus,
  }).from(orders).where(eq(orders.id, order.id))
  const origin = new URL(context.req.url).origin
  if (existing) {
    if (existing.email !== order.email) return error(context, 409, 'Odśwież koszyk i spróbuj ponownie.')
    if (!existing.stripeSessionId && existing.paymentStatus === 'unpaid') {
      return error(context, 503, 'Płatność jest przygotowywana. Spróbuj ponownie za chwilę.')
    }
    if (!existing.stripeSessionId || existing.paymentStatus !== 'unpaid') {
      return error(context, 409, 'To zamówienie nie może rozpocząć nowej płatności. Odśwież koszyk.')
    }
    const previousSession = await getStripe().checkout.sessions.retrieve(existing.stripeSessionId)
    if (previousSession.status === 'open' && previousSession.url) return context.json({ url: previousSession.url })
    if (previousSession.status === 'complete') {
      return context.json({ url: `${origin}/success/?session_id=${encodeURIComponent(previousSession.id)}` })
    }
    return error(context, 409, 'Sesja płatności wygasła. Odśwież koszyk i spróbuj ponownie.')
  }

  let items
  let descriptions
  let totalGrosz
  try {
    await db.transaction(async (transaction) => {
      const [racedOrder] = await transaction.select({ id: orders.id }).from(orders)
        .where(eq(orders.id, order.id)).for('update')
      if (racedOrder) throw new CheckoutInProgressError()

      const selected = await transaction.select({
        id: products.id,
        name: products.name,
        description: products.description,
        priceGrosz: products.priceGrosz,
      }).from(products).where(and(
        eq(products.published, true),
        inArray(products.id, [...order.quantities.keys()]),
      )).for('share')
      if (selected.length !== order.quantities.size) throw new InventoryUnavailableError()

      items = selected.map((product) => ({
        id: product.id,
        name: product.name,
        priceGrosz: product.priceGrosz,
        quantity: order.quantities.get(product.id),
      }))
      descriptions = new Map(selected.map((product) => [product.id, product.description]))
      totalGrosz = items.reduce((total, item) => total + item.priceGrosz * item.quantity, 0)

      const [created] = await transaction.insert(orders).values({
        id: order.id,
        email: order.email,
        items,
        totalGrosz,
      }).onConflictDoNothing().returning({ id: orders.id })
      if (!created) throw new CheckoutInProgressError()

      for (const item of items) {
        const codes = await transaction.select({ id: activationCodes.id }).from(activationCodes)
          .where(and(
            eq(activationCodes.productId, item.id),
            isNull(activationCodes.orderId),
            isNull(activationCodes.reservedOrderId),
          ))
          .orderBy(asc(activationCodes.createdAt), asc(activationCodes.id))
          .limit(item.quantity)
          .for('update', { skipLocked: true })
        if (codes.length !== item.quantity) throw new InventoryUnavailableError()
        await transaction.update(activationCodes).set({
          reservedOrderId: order.id,
          reservationExpiresAt: sql`now() + interval '30 minutes'`,
        }).where(inArray(activationCodes.id, codes.map(({ id }) => id)))
      }
    })
  } catch (cause) {
    if (cause instanceof InventoryUnavailableError) {
      return error(context, 409, 'Brak wystarczającej liczby kodów dla wybranych produktów. Odśwież katalog.')
    }
    if (cause instanceof CheckoutInProgressError) {
      return error(context, 503, 'Płatność jest przygotowywana. Spróbuj ponownie za chwilę.')
    }
    throw cause
  }

  let session
  try {
    session = await getStripe().checkout.sessions.create({
      ui_mode: 'hosted_page',
      mode: 'payment',
      locale: 'pl',
      client_reference_id: order.id,
      customer_email: order.email,
      line_items: items.map((item) => ({
        price_data: {
          currency: 'pln',
          product_data: { name: item.name, description: descriptions.get(item.id)?.slice(0, 500) },
          unit_amount: item.priceGrosz,
        },
        quantity: item.quantity,
      })),
      metadata: { order_id: order.id },
      success_url: `${origin}/success/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cancelled=1#katalog`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    }, { idempotencyKey: order.id })
    if (!session.url) throw new Error('Stripe did not return a Checkout URL.')
    const updated = await db.update(orders).set({ stripeSessionId: session.id })
      .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, 'unpaid')))
      .returning({ id: orders.id })
    if (updated.length !== 1) throw new Error('Could not save the Checkout Session.')
    return context.json({ url: session.url }, 201)
  } catch (cause) {
    if (session?.id) await getStripe().checkout.sessions.expire(session.id).catch(() => {})
    await releaseReservation(order.id, 'failed').catch(() => {})
    throw cause
  }
})

app.post('/api/stripe/webhook', async (context) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const signature = context.req.header('stripe-signature')
  if (!secret) return error(context, 503, 'Webhook Stripe nie jest skonfigurowany.')
  if (!signature) return error(context, 400, 'Brak podpisu webhooka.')

  let event
  try {
    event = getStripe().webhooks.constructEvent(await context.req.text(), signature, secret)
  } catch {
    return error(context, 400, 'Nieprawidłowy podpis webhooka.')
  }

  const session = event.data.object
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (session.payment_status === 'paid') {
      const result = await fulfillPaidOrder(session)
      if (!result) return error(context, 409, 'Zamówienie nie zostało dopasowane do płatności.')
      if (result.missing) return error(context, 503, 'Nie udało się zrealizować wszystkich kodów.')
    }
  } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    const orderId = session?.metadata?.order_id
    if (uuid.test(orderId ?? '')) {
      await releaseReservation(orderId, event.type.endsWith('expired') ? 'expired' : 'failed')
    }
  }
  return context.json({ received: true })
})

app.get('/api/claim', async (context) => {
  const sessionId = context.req.query('session_id')
  if (!sessionId || sessionId.length > 255 || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return error(context, 400, 'Nieprawidłowa sesja płatności.')
  }

  const session = await getStripe().checkout.sessions.retrieve(sessionId).catch(() => null)
  if (!session) return error(context, 404, 'Nie znaleziono płatności.')
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return context.json({ pending: true }, 202)
  }
  const result = await fulfillPaidOrder(session)
  if (!result) return error(context, 404, 'Nie znaleziono powiązanego zamówienia.')
  if (result.missing) return error(context, 503, 'Płatność została potwierdzona, ale kody wymagają ręcznej realizacji.')
  return context.json({ codes: result.codes })
})

app.get('/api/admin/session', (context) => context.json({ admin: true }))
app.get('/api/admin/products', (context) => readPage(products, context))
app.get('/api/admin/orders', (context) => readPage(orders, context))

app.post('/api/admin/products', async (context) => {
  const product = productInput(await context.req.json().catch(() => null))
  if (!product) return error(context, 400, 'Sprawdź nazwę, opis, kategorię i cenę produktu.')
  const [created] = await db.insert(products).values(product).returning()
  return context.json(created, 201)
})

app.post('/api/admin/products/:id/codes', async (context) => {
  const id = context.req.param('id')
  const codes = parseActivationCodes(await context.req.json().catch(() => null))
  if (!uuid.test(id) || !codes) return error(context, 400, 'Dodaj od 1 do 500 poprawnych kodów, po jednym w każdym wierszu.')
  const inserted = await db.insert(activationCodes).values(codes.map((code) => ({
    productId: id,
    code,
    codeHash: activationCodeHash(code),
  }))).onConflictDoNothing().returning({ id: activationCodes.id })
  return context.json({ added: inserted.length, skipped: codes.length - inserted.length })
})

app.patch('/api/admin/products/:id', async (context) => {
  const id = context.req.param('id')
  const product = productInput(await context.req.json().catch(() => null))
  if (!uuid.test(id) || !product) return error(context, 400, 'Sprawdź dane produktu.')
  const [updated] = await db.update(products).set(product).where(eq(products.id, id)).returning()
  if (!updated) return error(context, 404, 'Nie znaleziono produktu.')
  return context.json(updated)
})

app.patch('/api/admin/orders/:id', async (context) => {
  const id = context.req.param('id')
  const input = await context.req.json().catch(() => null)
  if (!uuid.test(id) || !status.enumValues.includes(input?.status)) return error(context, 400, 'Nieprawidłowy status zamówienia.')
  const [order] = await db.select({ paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, id))
  if (!order) return error(context, 404, 'Nie znaleziono zamówienia.')
  if (input.status === 'completed' && order.paymentStatus !== 'paid') {
    return error(context, 409, 'Zamówienie można zrealizować dopiero po potwierdzeniu płatności.')
  }
  const [updated] = await db.update(orders).set({ status: input.status }).where(eq(orders.id, id)).returning({ id: orders.id })
  return context.json(updated)
})

app.notFound((context) => error(context, 404, 'Nie znaleziono strony.'))
app.onError((cause, context) => error(context, 503, 'Usługa jest chwilowo niedostępna. Spróbuj ponownie.'))

export const config = { path: '/api/*' }

export default function handle(request, context) {
  return app.fetch(request, { siteUrl: context?.site?.url })
}
