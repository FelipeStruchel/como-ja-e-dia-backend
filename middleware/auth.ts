import { Request, Response, NextFunction } from "express";
import { verifyToken, getUserById } from "../services/authService.js";

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
    (req as Request & { user: typeof user }).user = user;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}
