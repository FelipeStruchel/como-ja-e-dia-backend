import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const triggerSchema = new Schema(
    {
        name: { type: String, default: "" },
        phrases: { type: [String], required: true },
        matchType: {
            type: String,
            enum: ["exact", "contains", "regex"],
            default: "exact",
        },
        caseSensitive: { type: Boolean, default: false },
        normalizeAccents: { type: Boolean, default: true },
        wholeWord: { type: Boolean, default: true },
        responseType: {
            type: String,
            enum: ["text", "image", "video"],
            default: "text",
        },
        responseText: { type: String, default: "" },
        responseMediaUrl: { type: String, default: "" },
        replyMode: { type: String, enum: ["reply", "new"], default: "reply" },
        mentionSender: { type: Boolean, default: false },
        chancePercent: { type: Number, default: 100 },
        expiresAt: { type: Date, default: null },
        maxUses: { type: Number, default: null },
        triggeredCount: { type: Number, default: 0 },
        cooldownSeconds: { type: Number, default: 0 },
        cooldownPerUserSeconds: { type: Number, default: 0 },
        active: { type: Boolean, default: true },
        allowedUsers: { type: [String], default: [] },
    },
    { timestamps: true }
);

export const Trigger =
    models.Trigger || _model("Trigger", triggerSchema);
