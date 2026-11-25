import { getIdentityConfig } from '@netlify/identity'
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie } from 'hono/cookie'
import { db } from '../../db/index.ts'
import { category, orders, products, status } from '../../db/schema.ts'

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
    !category.enumValues.includes(input.category) || typeof input.published !== 'boolean' ||
    !Number.isInteger(input.priceGrosz) || input.priceGrosz < 1 || input.priceGrosz > 999999) return null
  return { name, description, category: input.category, priceGrosz: input.priceGrosz, published: input.published }
}

function orderInput(input) {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (typeof input?.id !== 'string' || !uuid.test(input.id) || email.length > 254 || !emailPattern.test(email) ||
    !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10) return null
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

async function readPage(table, context, where) {
  const query = context.req.query('page') || '1'
  if (!/^[1-9]\d{0,3}$/.test(query)) return error(context, 400, 'Nieprawidłowy numer strony.')
  const page = Number(query)
  const rows = await db.select().from(table).where(where).orderBy(desc(table.createdAt), desc(table.id))
    .offset((page - 1) * pageSize).limit(pageSize + 1)
  return context.json({ records: rows.slice(0, pageSize), hasMore: rows.length > pageSize })
}

app.use('/api/*', async (context, next) => {
  context.header('Cache-Control', 'no-store')
  context.header('X-Content-Type-Options', 'nosniff')
  if (['POST', 'PATCH'].includes(context.req.method)) {
    const origin = context.req.header('Origin')
    if (origin !== new URL(context.req.url).origin) return error(context, 403, 'Niedozwolone źródło żądania.')
    if (context.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return error(context, 415, 'Oczekiwano danych JSON.')
    }
  }
  await next()
})

app.use('/api/*', bodyLimit({
  maxSize: 16 * 1024,
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
  return context.json(product)
})

app.post('/api/orders', async (context) => {
  const input = await context.req.json().catch(() => null)
  const order = orderInput(input)
  if (!order || input.website) return error(context, 400, 'Sprawdź adres e-mail i produkty w koszyku.')
  const [previous] = await db.select({ id: orders.id, email: orders.email }).from(orders).where(eq(orders.id, order.id))
  if (previous) {
    if (previous.email !== order.email) return error(context, 409, 'Odśwież koszyk i spróbuj ponownie.')
    return context.json({ id: previous.id })
  }
  const selected = await db.select().from(products).where(and(
    eq(products.published, true),
    inArray(products.id, [...order.quantities.keys()]),
  ))
  if (selected.length !== order.quantities.size) return error(context, 409, 'Co najmniej jeden produkt nie jest już dostępny. Sprawdź katalog.')
  const items = selected.map(({ id, name, priceGrosz }) => ({ id, name, priceGrosz, quantity: order.quantities.get(id) }))
  const totalGrosz = items.reduce((total, item) => total + item.priceGrosz * item.quantity, 0)
  if (input.totalGrosz !== totalGrosz) return error(context, 409, 'Cena się zmieniła. Sprawdź koszyk i potwierdź zamówienie ponownie.')
  const [created] = await db.insert(orders).values({ id: order.id, email: order.email, items, totalGrosz })
    .onConflictDoNothing().returning({ id: orders.id })
  if (created) return context.json(created, 201)
  const [duplicate] = await db.select({ email: orders.email }).from(orders).where(eq(orders.id, order.id))
  if (duplicate?.email !== order.email) return error(context, 409, 'Odśwież koszyk i spróbuj ponownie.')
  return context.json({ id: order.id })
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
  const [updated] = await db.update(orders).set({ status: input.status }).where(eq(orders.id, id)).returning({ id: orders.id })
  if (!updated) return error(context, 404, 'Nie znaleziono zamówienia.')
  return context.json(updated)
})

app.notFound((context) => error(context, 404, 'Nie znaleziono strony.'))
app.onError((cause, context) => error(context, 503, 'Usługa jest chwilowo niedostępna. Spróbuj ponownie.'))

export const config = { path: '/api/*' }

export default function handle(request, context) {
  return app.fetch(request, { siteUrl: context?.site?.url })
}
