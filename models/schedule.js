import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const scheduleSchema = new Schema(
    {
        name: { type: String, required: true },
        kind: { type: String, enum: ["greeting"], default: "greeting" }, // para evoluir outros tipos
        type: { type: String, enum: ["text", "image", "video"], required: true },
        mediaUrl: { type: String, default: "" }, // para image/video
        textContent: { type: String, default: "" }, // para text
        captionMode: { type: String, enum: ["auto", "custom", "none"], default: "auto" },
        customCaption: { type: String, default: "" },
        includeIntro: { type: Boolean, default: true },
        cleanupAfterSend: { type: Boolean, default: false },
        includeRandomPool: { type: Boolean, default: true },
        personaPrompt: { type: String, default: "" }, // se vazio, usa default
        cron: { type: String, required: true },
        timezone: { type: String, default: "America/Sao_Paulo" },
        startDate: { type: Date, default: null },
        endDate: { type: Date, default: null },
        daysOfWeek: { type: [Number], default: [] }, // 0-6 (domingo-sábado). vazio = todos
        active: { type: Boolean, default: true },
        repeatJobKey: { type: String, default: "" }, // armazenar chave do repeatable para remoção
    },
    { timestamps: true }
);

export const Schedule =
    models.Schedule || _model("Schedule", scheduleSchema);
