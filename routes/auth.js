import {
    registerUser,
    authenticateUser,
    verifyToken,
    getUserById,
    listUsers,
    setUserStatus,
} from "../services/authService.js";

function requireAuth(req) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) throw new Error("Token ausente");
    const payload = verifyToken(token);
    return payload;
}

export function registerAuthRoutes(app) {
    app.post("/auth/register", async (req, res) => {
        try {
            const { email, password, name } = req.body || {};
            const user = await registerUser({ email, password, name });
            res.status(201).json({
                message: "Cadastro realizado. Aguarde aprovação.",
                status: user.status,
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
                user: { id: user._id, email: user.email, name: user.name, status: user.status },
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
                user: {
                    id: user._id,
                    email: user.email,
                    name: user.name,
                    status: user.status,
                },
            });
        } catch (err) {
            res.status(401).json({ error: "Token inválido" });
        }
    });

    // Admin: listar usuários
    app.get("/auth/users", async (req, res) => {
        try {
            const payload = requireAuth(req);
            if (!payload) return res.status(401).json({ error: "Token inválido" });
            const { status } = req.query;
            const users = await listUsers({ status });
            res.json(
                users.map((u) => ({
                    id: u._id,
                    email: u.email,
                    name: u.name,
                    status: u.status,
                    createdAt: u.createdAt,
                }))
            );
        } catch (err) {
            res.status(401).json({ error: err.message || "Não autorizado" });
        }
    });

    // Admin: aprovar
    app.post("/auth/users/:id/approve", async (req, res) => {
        try {
            const payload = requireAuth(req);
            if (!payload) return res.status(401).json({ error: "Token inválido" });
            const updated = await setUserStatus(req.params.id, "approved");
            if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
            res.json({ message: "Usuário aprovado" });
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao aprovar" });
        }
    });

    // Admin: bloquear
    app.post("/auth/users/:id/block", async (req, res) => {
        try {
            const payload = requireAuth(req);
            if (!payload) return res.status(401).json({ error: "Token inválido" });
            const updated = await setUserStatus(req.params.id, "blocked");
            if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
            res.json({ message: "Usuário bloqueado" });
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao bloquear" });
        }
    });
}
