import mongoose from "mongoose";
const { Schema, models, model: _model } = mongoose;

const memberSchema = new Schema(
    {
        id: { type: String, required: true },
        name: { type: String, default: "" },
        pushname: { type: String, default: "" },
        isAdmin: { type: Boolean, default: false },
        profilePicUrl: { type: String, default: "" },
    },
    { _id: false }
);

const groupContextSchema = new Schema({
    groupId: { type: String, required: true, index: true, unique: true },
    subject: { type: String, default: "" },
    description: { type: String, default: "" },
    members: [memberSchema],
    fetchedAt: { type: Date, default: Date.now },
});

export const GroupContext =
    models.GroupContext || _model("GroupContext", groupContextSchema);
