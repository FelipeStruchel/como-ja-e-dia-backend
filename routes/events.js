export function registerEventRoutes(app, { Event, isDbConnected, tz, moment }) {
    app.get("/events", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            const now = new Date();
            const events = await Event.find({
                announced: false,
                claimedBy: null,
                date: { $gt: now },
            })
                .sort({ date: 1 })
                .lean();
            res.json(events);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/events", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            const { name, date } = req.body; // date expected as ISO string
            if (!name || !date)
                return res.status(400).json({ error: "name and date are required" });

            let m = tz(date, "America/Sao_Paulo");

            if (!m.isValid()) {
                m = moment(date);
                if (!m.isValid())
                    return res.status(400).json({ error: "Invalid date format" });
            }

            const nowSP = tz("America/Sao_Paulo");
            if (m.isBefore(nowSP)) {
                return res.status(400).json({ error: "Cannot create event in the past" });
            }

            const ev = new Event({ name, date: m.toDate() });
            await ev.save();
            res.status(201).json(ev);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete("/events/:id", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            const id = req.params.id;
            await Event.findByIdAndDelete(id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}
