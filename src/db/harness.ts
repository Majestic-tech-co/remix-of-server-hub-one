// Shared setup for the database tests: a real Postgres engine (PGlite) with Supabase-style roles, a stub
// `auth` schema, and every migration applied in order.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

export const DIR = join(process.cwd(), "supabase", "migrations");
export const DENIED = /permission denied|row-level security|violates|row limit|does not exist|must keep/i;

/** Boot a fresh database. `skipFrom` stops before that migration file (for upgrade tests). */
export async function boot(autoExpose: boolean, skipFrom?: string): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT SELECT ON auth.users TO service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
    CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, status text NOT NULL);
  `);
  if (autoExpose) {
    await db.exec(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `);
  }
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (skipFrom && f >= skipFrom) break;
    try {
      await db.exec(readFileSync(join(DIR, f), "utf8"));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return db;
}
