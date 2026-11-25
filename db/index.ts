import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.ts'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to connect the store to Neon.')
}

const databaseUrl = new URL(process.env.DATABASE_URL)
databaseUrl.searchParams.set('sslmode', 'verify-full')
export const pool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: { rejectUnauthorized: true },
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 8_000,
})

export const db = drizzle({ client: pool, schema })
