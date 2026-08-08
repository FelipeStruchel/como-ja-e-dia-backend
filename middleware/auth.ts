import { Request, Response, NextFunction } from "express";
import { verifyToken, getUserById } from "../services/authService.js";
import { isGroupAdminOf } from "../services/groupService.js";

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

export function requireWorkerOrRole(...slugs: string[]) {
  const roleMiddleware = requireRole(...slugs);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const workerSecret = process.env.WORKER_API_SECRET;
    if (workerSecret && req.headers["x-worker-secret"] === workerSecret) {
      next();
      return;
    }
    await requireAuth(req, res, () => roleMiddleware(req, res, next));
  };
}

export function requireGroupAdmin(
  getGroupId: (req: Request) => string | null | Promise<string | null>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await requireAuth(req, res, async () => {
      try {
        const user = req.user!;
        const userSlugs = user.roles?.map((ur) => ur.role.slug) ?? [];
        if (userSlugs.includes("super_admin")) {
          next();
          return;
        }
        const groupId = await getGroupId(req);
        if (!groupId) {
          res.status(403).json({ error: "Sem permissão para operar fora de um grupo específico" });
          return;
        }
        const isAdmin = await isGroupAdminOf(user.id, groupId);
        if (!isAdmin) {
          res.status(403).json({ error: "Sem permissão neste grupo" });
          return;
        }
        next();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro ao verificar permissão do grupo";
        res.status(500).json({ error: msg });
      }
    });
  };
}
