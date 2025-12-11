import nodemailer from "nodemailer";
import {
    registerUser,
    authenticateUser,
    verifyToken,
    getUserById,
    listUsers,
    setUserStatus,
} from "../services/authService.js";

function buildMailer() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
        // eslint-disable-next-line no-console
        console.warn("[mail] SMTP não configurado; emails de aprovação serão pulados");
        return null;
    }

    return nodemailer.createTransport({
        host,
        port,
        secure: Boolean(process.env.SMTP_SECURE === "true"),
        auth: { user, pass },
    });
}

function getApprovalLink(userId) {
    const base = process.env.APPROVAL_LINK_BASE || process.env.BACKEND_PUBLIC_URL || "";
    if (!base) return "";
    const url = new URL("/auth/approve", base);
    const tokenPayload = Buffer.from(JSON.stringify({ sub: userId, action: "approve" })).toString(
        "base64"
    );
    url.searchParams.set("token", tokenPayload);
    return url.toString();
}

function requireAuth(req) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) throw new Error("Token ausente");
    const payload = verifyToken(token);
    return payload;
}

export function registerAuthRoutes(app) {
    const mailer = buildMailer();

    app.post("/auth/register", async (req, res) => {
        try {
            const { email, password, name } = req.body || {};
            const user = await registerUser({ email, password, name });

            // Tenta enviar email de aprovação
            const approvalTo = process.env.APPROVAL_EMAIL_TO;
            if (mailer && approvalTo) {
                const link = getApprovalLink(user._id.toString());
                if (link) {
                    await mailer.sendMail({
                        from: process.env.SMTP_FROM || approvalTo,
                        to: approvalTo,
                        subject: "Novo cadastro pendente - Como Já É Dia",
                        text: `Novo cadastro pendente: ${user.email}\n\nAprovar: ${link}`,
                        html: `<p>Novo cadastro pendente: <strong>${user.email}</strong></p><p><a href="${link}">Aprovar cadastro</a></p>`,
                    });
                }
            }

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

    // Aprovação via link (token simples base64) - opcional
    app.get("/auth/approve", async (req, res) => {
        try {
            const raw = req.query.token;
            if (!raw) return res.status(400).json({ error: "Token ausente" });
            const decoded = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
            if (decoded?.action !== "approve" || !decoded?.sub) {
                return res.status(400).json({ error: "Token inválido" });
            }
            const updated = await setUserStatus(decoded.sub, "approved");
            if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
            res.json({ message: "Usuário aprovado", userId: decoded.sub });
        } catch (err) {
            res.status(400).json({ error: err.message || "Erro ao aprovar" });
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
