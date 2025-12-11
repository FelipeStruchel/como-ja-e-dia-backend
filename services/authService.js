import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/user.js";

const DEFAULT_JWT_TTL = "7d";

function getJwtSecret() {
    if (!process.env.JWT_SECRET) {
        return "dev-secret-change-me";
    }
    return process.env.JWT_SECRET;
}

export async function registerUser({ email, password, name }) {
    const normalized = String(email || "").toLowerCase().trim();
    if (!normalized || !password) {
        throw new Error("Email e senha são obrigatórios");
    }

    const exists = await User.findOne({ email: normalized });
    if (exists) {
        throw new Error("Email já cadastrado");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
        email: normalized,
        name: name || "",
        passwordHash,
        status: "pending",
    });

    return user;
}

export async function authenticateUser({ email, password }) {
    const normalized = String(email || "").toLowerCase().trim();
    const user = await User.findOne({ email: normalized });
    if (!user) throw new Error("Credenciais inválidas");

    const ok = await bcrypt.compare(password || "", user.passwordHash);
    if (!ok) throw new Error("Credenciais inválidas");

    if (user.status === "pending") {
        throw new Error("Cadastro pendente de aprovação");
    }
    if (user.status === "blocked") {
        throw new Error("Usuário bloqueado");
    }

    const token = jwt.sign(
        { sub: user._id.toString(), email: user.email },
        getJwtSecret(),
        { expiresIn: process.env.JWT_TTL || DEFAULT_JWT_TTL }
    );

    return { user, token };
}

export function verifyToken(token) {
    return jwt.verify(token, getJwtSecret());
}

export async function getUserById(id) {
    return User.findById(id).lean();
}

export async function listUsers({ status }) {
    const query = {};
    if (status) query.status = status;
    return User.find(query).sort({ createdAt: -1 }).lean();
}

export async function setUserStatus(id, status) {
    return User.findByIdAndUpdate(id, { status }, { new: true }).lean();
}
