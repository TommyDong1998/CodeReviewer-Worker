import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set');
}

// Configure connection pooling to prevent exhaustion
export const client = postgres(process.env.POSTGRES_URL, {
  max: 20,                    // Maximum number of connections in the pool
  idle_timeout: 20,           // Close idle connections after 20 seconds
  connect_timeout: 10,        // Connection timeout in seconds
  max_lifetime: 60 * 30,      // Recycle connections after 30 minutes
  prepare: false,             // Disable prepared statements for better compatibility
});

export const db = drizzle(client, { schema });
