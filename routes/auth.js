import {
    registerUser,
    authenticateUser,
    verifyToken,
    getUserById,
} from "../services/authService.js";

export function registerAuthRoutes(app) {
    app.post("/auth/register", async (req, res) => {
        try {
            const { email, password, name } = req.body || {};
            const user = await registerUser({ email, password, name });
            const { token } = await authenticateUser({ email, password });
            res.json({
                token,
                user: { id: user._id, email: user.email, name: user.name },
            });
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao registrar" });
        }
    });

    app.post("/auth/login", async (req, res) => {
        try {
            const { email, password } = req.body || {};
            const { user, token } = await authenticateUser({ email, password });
            res.json({
                token,
                user: { id: user._id, email: user.email, name: user.name },
            });
        } catch (err) {
            res.status(401).json({ error: err.message || "Credenciais inválidas" });
        }
    });

    app.get("/auth/me", async (req, res) => {
        try {
            const auth = req.headers.authorization || "";
            const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
            if (!token) return res.status(401).json({ error: "Token ausente" });
            const payload = verifyToken(token);
            const user = await getUserById(payload.sub);
            if (!user) return res.status(401).json({ error: "Usuário não encontrado" });
            res.json({
                user: { id: user._id, email: user.email, name: user.name },
            });
        } catch (err) {
            res.status(401).json({ error: "Token inválido" });
        }
    });
}
