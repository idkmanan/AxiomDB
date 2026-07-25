import "dotenv/config";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

let db;

if (process.env.NODE_ENV === "development") {
  const { Pool } = await import("pg");
  const { drizzle: drizzlePg } = await import("drizzle-orm/node-postgres");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  db = drizzlePg(pool);
} else {
  const sql = neon(process.env.DATABASE_URL);
  db = drizzle(sql);
}

export { db };