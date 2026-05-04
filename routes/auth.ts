import { Express } from "express";
import {
  registerUser,
  authenticateUser,
  getUserById,
  listUsers,
  setUserActive,
  assignRole,
  removeRole,
  listRoles,
  verifyToken,
} from "../services/authService.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

function serializeUser(u: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    active: u.active,
    createdAt: u.createdAt,
    roles: u.roles.map((ur) => ur.role.slug),
  };
}

export function registerAuthRoutes(app: Express) {
  app.post("/auth/register", async (req, res) => {
    try {
      const { email, password, name } = req.body || {};
      await registerUser({ email, password, name });
      res.status(201).json({ message: "Cadastro realizado. Aguarde aprovação." });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao registrar";
      res.status(400).json({ error: msg });
    }
  });

  app.post("/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const { user, token } = await authenticateUser({ email, password });
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          active: user.active,
          roles: user.roles.map((ur) => ur.role.slug),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Credenciais inválidas";
      res.status(401).json({ error: msg });
    }
  });

  app.get("/auth/me", async (req, res) => {
    try {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Token ausente" });
      const payload = verifyToken(token);
      const user = await getUserById(payload.sub as string);
      if (!user) return res.status(401).json({ error: "Usuário não encontrado" });
      res.json({ user: serializeUser(user) });
    } catch {
      res.status(401).json({ error: "Token inválido" });
    }
  });

  // --- User management (super_admin only) ---

  app.get("/auth/users", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const users = await listUsers();
      res.json(users.map(serializeUser));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar usuários";
      res.status(500).json({ error: msg });
    }
  });

  app.patch("/auth/users/:id/active", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      const { active } = req.body || {};
      if (typeof active !== "boolean") {
        return res.status(400).json({ error: "Campo 'active' deve ser boolean" });
      }
      const updated = await setUserActive(req.params.id, active);
      if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
      res.json({ message: "Status atualizado" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao atualizar";
      res.status(400).json({ error: msg });
    }
  });

  app.post("/auth/users/:id/roles/:slug", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      await assignRole(req.params.id, req.params.slug);
      res.json({ message: "Role atribuída" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao atribuir role";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/auth/users/:id/roles/:slug", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
      await removeRole(req.params.id, req.params.slug);
      res.json({ message: "Role removida" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao remover role";
      res.status(400).json({ error: msg });
    }
  });

  app.get("/auth/roles", requireAuth, requireRole("super_admin"), async (_req, res) => {
    try {
      const roles = await listRoles();
      res.json(roles);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao listar roles";
      res.status(500).json({ error: msg });
    }
  });
}
