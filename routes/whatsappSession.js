export function registerWhatsAppSessionRoutes(app, { prisma }) {
    app.head("/whatsapp-session/:id", async (req, res) => {
        const record = await prisma.whatsAppSession.findUnique({ where: { id: req.params.id } });
        res.sendStatus(record ? 200 : 404);
    });

    app.get("/whatsapp-session/:id", async (req, res) => {
        const record = await prisma.whatsAppSession.findUnique({ where: { id: req.params.id } });
        if (!record) return res.sendStatus(404);
        res.set("Content-Type", "application/octet-stream");
        res.send(record.data);
    });

    app.put("/whatsapp-session/:id", async (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", async () => {
            const data = Buffer.concat(chunks);
            await prisma.whatsAppSession.upsert({
                where: { id: req.params.id },
                create: { id: req.params.id, data },
                update: { data },
            });
            res.sendStatus(200);
        });
    });

    app.delete("/whatsapp-session/:id", async (req, res) => {
        await prisma.whatsAppSession.deleteMany({ where: { id: req.params.id } });
        res.sendStatus(200);
    });
}
