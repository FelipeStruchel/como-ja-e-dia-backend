import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const phraseSchema = new Schema({
    text: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
});

export const Phrase = models.Phrase || _model("Phrase", phraseSchema);
