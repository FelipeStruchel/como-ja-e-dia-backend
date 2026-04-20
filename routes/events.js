export function registerEventRoutes(app, { prisma, isDbConnected, tz, moment }) {
    app.get("/events", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            const now = new Date();
            const events = await prisma.event.findMany({
                where: { announced: false, claimedBy: null, date: { gt: now } },
                orderBy: { date: "asc" },
            });
            res.json(events);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/events", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            const { name, date } = req.body;
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

            const ev = await prisma.event.create({ data: { name, date: m.toDate() } });
            res.status(201).json(ev);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete("/events/:id", async (req, res) => {
        if (!isDbConnected()) return res.status(503).json({ error: "DB unavailable" });
        try {
            await prisma.event.delete({ where: { id: req.params.id } });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}
