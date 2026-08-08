import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

const DEFAULT_JWT_TTL = "7d";

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "dev-secret-change-me";
}

const userWithRoles = {
  include: { roles: { include: { role: true } } },
} as const;

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
    data: { email: normalized, name: name || "", passwordHash, active: false },
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
  const user = await prisma.user.findUnique({
    where: { email: normalized },
    ...userWithRoles,
  });
  if (!user) throw new Error("Credenciais inválidas");
  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) throw new Error("Credenciais inválidas");
  if (!user.active) throw new Error("Conta inativa");
  const roles = user.roles.map((ur) => ur.role.slug);
  const token = jwt.sign(
    { sub: user.id, email: user.email, roles },
    getJwtSecret(),
    { expiresIn: process.env.JWT_TTL || DEFAULT_JWT_TTL } as jwt.SignOptions
  );
  return { user, token };
}

export function verifyToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
}

export async function getUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    ...userWithRoles,
  });
}

export async function listUsers() {
  return prisma.user.findMany({
    ...userWithRoles,
    orderBy: { createdAt: "desc" },
  });
}

export async function setUserActive(id: string, active: boolean) {
  try {
    return await prisma.user.update({ where: { id }, data: { active } });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2025") return null;
    throw err;
  }
}

export async function assignRole(userId: string, roleSlug: string) {
  const role = await prisma.role.findUnique({ where: { slug: roleSlug } });
  if (!role) throw new Error("Role não encontrada");
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
}

export async function removeRole(userId: string, roleSlug: string) {
  const role = await prisma.role.findUnique({ where: { slug: roleSlug } });
  if (!role) return;
  await prisma.userRole.deleteMany({ where: { userId, roleId: role.id } });
}

export async function listRoles() {
  // bom_dia_admin is retired — every route that checked it now checks
  // per-group GroupAdmin membership instead, so assigning it does nothing.
  // The Role row itself is kept (in case the slug is ever reused), just
  // hidden from the assignable list to avoid confusing super_admin.
  return prisma.role.findMany({
    where: { slug: { not: "bom_dia_admin" } },
    orderBy: { name: "asc" },
  });
}
