import { defineConfig } from "prisma/config";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/comojaedia";

export default defineConfig({
  earlyAccess: true,
  schema: "prisma/schema.prisma",
  datasource: {
    url: connectionString,
  },
  migrate: {
    async adapter() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString });
      return new PrismaPg(pool);
    },
  },
});
