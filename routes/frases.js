export function registerPhraseRoutes(app, { MAX_MESSAGE_LENGTH, prisma }) {
    app.get("/frases", async (_req, res) => {
        try {
            const docs = await prisma.phrase.findMany({ orderBy: { createdAt: "asc" } });
            res.json(docs.map((d) => d.text));
        } catch (error) {
            console.error("Erro ao buscar frases:", error);
            res.status(500).json({ error: "Erro ao buscar frases" });
        }
    });

    app.post("/frases", async (req, res) => {
        try {
            const { frase } = req.body || {};
            if (!frase) {
                return res.status(400).json({ error: "Frase e obrigatoria" });
            }
            if (frase.length > MAX_MESSAGE_LENGTH) {
                return res.status(400).json({
                    error: `A frase deve ter no maximo ${MAX_MESSAGE_LENGTH} caracteres`,
                    maxLength: MAX_MESSAGE_LENGTH,
                });
            }
            const doc = await prisma.phrase.create({ data: { text: frase } });
            res.status(201).json({ message: "Frase adicionada com sucesso", frase: doc.text });
        } catch (error) {
            console.error("Erro ao adicionar frase:", error);
            res.status(500).json({ error: "Erro ao adicionar frase" });
        }
    });

    app.delete("/frases/by-id/:id", async (req, res) => {
        try {
            const { id } = req.params;
            if (!id) return res.status(400).json({ error: "ID obrigatorio" });
            try {
                await prisma.phrase.delete({ where: { id } });
            } catch (err) {
                if (err.code === "P2025")
                    return res.status(404).json({ error: "Frase nao encontrada" });
                throw err;
            }
            res.json({ message: "Frase removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: "Erro ao remover frase" });
        }
    });

    app.delete("/frases/:index", async (req, res) => {
        try {
            const index = parseInt(req.params.index, 10);
            const docs = await prisma.phrase.findMany({ orderBy: { createdAt: "asc" } });
            if (Number.isNaN(index) || index < 0 || index >= docs.length) {
                return res.status(404).json({ error: "Frase nao encontrada" });
            }
            await prisma.phrase.delete({ where: { id: docs[index].id } });
            res.json({ message: "Frase removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: "Erro ao remover frase" });
        }
    });
}
