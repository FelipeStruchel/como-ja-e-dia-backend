import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const userSchema = new Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, default: "" },
    passwordHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
});

export const User = models.User || _model("User", userSchema);
