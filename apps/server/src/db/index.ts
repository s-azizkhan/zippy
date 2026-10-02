import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export const db = drizzle(postgres(process.env.DATABASE_URL!), { schema });
export * from "./schema.ts";
