import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const eventSchema = new Schema({
    name: { type: String, required: true },
    date: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
    announced: { type: Boolean, default: false },
    announcedAt: { type: Date, default: null },
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },
});

export const Event = models.Event || _model("Event", eventSchema);
