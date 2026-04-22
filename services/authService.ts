import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

const DEFAULT_JWT_TTL = "7d";

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "dev-secret-change-me";
}

export async function registerUser({
  email,
  password,
  name,
}: {
  email: string;
  password: string;
  name?: string;
}) {
  const normalized = String(email || "").toLowerCase().trim();
  if (!normalized || !password) {
    throw new Error("Email e senha são obrigatórios");
  }
  const exists = await prisma.user.findUnique({ where: { email: normalized } });
  if (exists) {
    throw new Error("Email já cadastrado");
  }
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: { email: normalized, name: name || "", passwordHash, status: "pending" },
  });
}

export async function authenticateUser({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  const normalized = String(email || "").toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) throw new Error("Credenciais inválidas");
  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) throw new Error("Credenciais inválidas");
  if (user.status === "pending") throw new Error("Cadastro pendente de aprovação");
  if (user.status === "blocked") throw new Error("Usuário bloqueado");
  const token = jwt.sign(
    { sub: user.id, email: user.email },
    getJwtSecret(),
    { expiresIn: process.env.JWT_TTL || DEFAULT_JWT_TTL } as jwt.SignOptions
  );
  return { user, token };
}

export function verifyToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
}

export async function getUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export async function listUsers({ status }: { status?: string }) {
  const where = status ? { status: status as import("@prisma/client").UserStatus } : {};
  return prisma.user.findMany({ where, orderBy: { createdAt: "desc" } });
}

export async function setUserStatus(id: string, status: string) {
  try {
    return await prisma.user.update({ where: { id }, data: { status: status as import("@prisma/client").UserStatus } });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2025") return null;
    throw err;
  }
}
