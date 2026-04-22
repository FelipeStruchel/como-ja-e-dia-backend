import { Express } from "express";
import {
  registerUser,
  authenticateUser,
  verifyToken,
  getUserById,
  listUsers,
  setUserStatus,
} from "../services/authService.js";

function requireAuth(req: { headers: { authorization?: string } }) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) throw new Error("Token ausente");
  return verifyToken(token);
}

export function registerAuthRoutes(app: Express) {
  app.post("/auth/register", async (req, res) => {
    try {
      const { email, password, name } = req.body || {};
      const user = await registerUser({ email, password, name });
      res.status(201).json({
        message: "Cadastro realizado. Aguarde aprovação.",
        status: user.status,
      });
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
        user: { id: user.id, email: user.email, name: user.name, status: user.status },
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
      res.json({ user: { id: user.id, email: user.email, name: user.name, status: user.status } });
    } catch {
      res.status(401).json({ error: "Token inválido" });
    }
  });

  app.get("/auth/users", async (req, res) => {
    try {
      const payload = requireAuth(req);
      if (!payload) return res.status(401).json({ error: "Token inválido" });
      const { status } = req.query as { status?: string };
      const users = await listUsers({ status });
      res.json(
        users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          status: u.status,
          createdAt: u.createdAt,
        }))
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Não autorizado";
      res.status(401).json({ error: msg });
    }
  });

  app.post("/auth/users/:id/approve", async (req, res) => {
    try {
      const payload = requireAuth(req);
      if (!payload) return res.status(401).json({ error: "Token inválido" });
      const updated = await setUserStatus(req.params.id, "approved");
      if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
      res.json({ message: "Usuário aprovado" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao aprovar";
      res.status(400).json({ error: msg });
    }
  });

  app.post("/auth/users/:id/block", async (req, res) => {
    try {
      const payload = requireAuth(req);
      if (!payload) return res.status(401).json({ error: "Token inválido" });
      const updated = await setUserStatus(req.params.id, "blocked");
      if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
      res.json({ message: "Usuário bloqueado" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao bloquear";
      res.status(400).json({ error: msg });
    }
  });
}
