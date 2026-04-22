import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { log } from "./logger.js";

// Garante que o pool seja configurado para reconectar
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/comojaedia",
  // Adicione estas opções para maior estabilidade no Docker
  max: 10, 
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000, 
});

// Tratamento de erro no pool
pool.on('error', (err) => {
  log('Erro inesperado no pool de conexões do Postgres: ' + err, 'error');
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });