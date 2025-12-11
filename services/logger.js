import { LogEntry } from "../models/logEntry.js";
import mongoose from "mongoose";

let connected = false;

async function ensureDb() {
    if (connected) return;
    const uri = process.env.MONGO_CONNECTION_STRING;
    if (!uri) {
        return;
    }
    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
            connectTimeoutMS: 10000,
            family: 4,
        });
        connected = true;
    } catch (err) {
        console.error(`[${new Date().toISOString()}] [ERROR] Falha ao conectar Mongo para logs: ${err.message}`);
    }
}

export async function log(message, type = "info", meta = null) {
    const ts = new Date().toISOString();
    const tag =
        {
            info: "[INFO]",
            error: "[ERROR]",
            success: "[SUCCESS]",
            warning: "[WARN]",
            debug: "[DEBUG]",
        }[type] || "[INFO]";

    console.log(`[${ts}] ${tag} ${message}`);

    try {
        await ensureDb();
        if (!connected) return;
        await LogEntry.create({
            source: "backend",
            level: type,
            message: String(message),
            meta,
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] [ERROR] Falha ao salvar log no Mongo: ${err.message}`);
    }
}
