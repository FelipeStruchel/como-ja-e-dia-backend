import { Request, Response, NextFunction } from "express";
import { verifyToken, getUserById } from "../services/authService.js";

type UserWithRoles = Awaited<ReturnType<typeof getUserById>>;

declare global {
  namespace Express {
    interface Request {
      user?: UserWithRoles;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Token ausente" });
      return;
    }
    const payload = verifyToken(token);
    const user = await getUserById(payload.sub as string);
    if (!user) {
      res.status(401).json({ error: "Usuário não encontrado" });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

export function requireRole(...slugs: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const userSlugs = user.roles?.map((ur) => ur.role.slug) ?? [];
    const hasAccess =
      userSlugs.includes("super_admin") || slugs.some((s) => userSlugs.includes(s));
    if (!hasAccess) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    next();
  };
}
