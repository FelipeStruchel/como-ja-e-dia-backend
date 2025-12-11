import { verifyToken, getUserById } from "../services/authService.js";

export async function requireAuth(req, res, next) {
    try {
        const auth = req.headers.authorization || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
        if (!token) {
            return res.status(401).json({ error: "Token ausente" });
        }
        const payload = verifyToken(token);
        const user = await getUserById(payload.sub);
        if (!user) {
            return res.status(401).json({ error: "Usuário não encontrado" });
        }
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Token inválido" });
    }
}
