import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const analysisLogSchema = new Schema({
    user: { type: String, required: true },
    chatId: { type: String, required: false },
    requestedN: { type: Number, default: 0 },
    analyzedCount: { type: Number, default: 0 },
    messages: { type: Array, default: [] },
    result: { type: String, default: null },
    error: { type: String, default: null },
    durationMs: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
});

export const AnalysisLog =
    models.AnalysisLog || _model("AnalysisLog", analysisLogSchema);
