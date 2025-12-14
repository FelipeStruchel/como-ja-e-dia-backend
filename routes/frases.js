export function registerPhraseRoutes(app, { MAX_MESSAGE_LENGTH, Phrase }) {
    // Lista todas as frases (ordenadas pela criacao) e retorna apenas o texto para manter compatibilidade
    app.get("/frases", async (_req, res) => {
        try {
            const docs = await Phrase.find().sort({ createdAt: 1 }).lean();
            const frases = docs.map((d) => d.text);
            res.json(frases);
        } catch (error) {
            console.error("Erro ao buscar frases:", error);
            res.status(500).json({ error: "Erro ao buscar frases" });
        }
    });

    // Adiciona nova frase
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
            const doc = await Phrase.create({ text: frase });
            res.status(201).json({ message: "Frase adicionada com sucesso", frase: doc.text });
        } catch (error) {
            console.error("Erro ao adicionar frase:", error);
            res.status(500).json({ error: "Erro ao adicionar frase" });
        }
    });

    // Remove frase por id (para limpezas automaticas)
    app.delete("/frases/by-id/:id", async (req, res) => {
        try {
            const id = req.params.id;
            if (!id) return res.status(400).json({ error: "ID obrigatorio" });
            const deleted = await Phrase.findByIdAndDelete(id);
            if (!deleted) return res.status(404).json({ error: "Frase nao encontrada" });
            res.json({ message: "Frase removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: "Erro ao remover frase" });
        }
    });

    // Remove frase por indice (compatibilidade com UI atual)
    app.delete("/frases/:index", async (req, res) => {
        try {
            const index = parseInt(req.params.index, 10);
            const docs = await Phrase.find().sort({ createdAt: 1 }).lean();
            if (Number.isNaN(index) || index < 0 || index >= docs.length) {
                return res.status(404).json({ error: "Frase nao encontrada" });
            }
            const target = docs[index];
            await Phrase.deleteOne({ _id: target._id });
            res.json({ message: "Frase removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: "Erro ao remover frase" });
        }
    });
}
