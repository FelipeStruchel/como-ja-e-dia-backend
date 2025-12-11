import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const logEntrySchema = new Schema({
    source: { type: String, default: "backend" },
    level: { type: String, default: "info" },
    message: { type: String, required: true },
    meta: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
});

export const LogEntry = models.LogEntry || _model("LogEntry", logEntrySchema);
