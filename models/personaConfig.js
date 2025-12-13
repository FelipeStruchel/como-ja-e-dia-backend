import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const personaSchema = new Schema(
    {
        prompt: { type: String, required: true },
    },
    { timestamps: true }
);

export const PersonaConfig =
    models.PersonaConfig || _model("PersonaConfig", personaSchema);
