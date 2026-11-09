import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import type { AppConfig } from '../config/env.ts';

export function createPrisma(config: AppConfig): PrismaClient {
  // Prisma 7 uses the official PostgreSQL driver adapter; bounded connection pools
  // are important when Cloud Run creates multiple instances.
  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
  });
  return new PrismaClient({ adapter });
}

export type Database = PrismaClient;
