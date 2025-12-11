import { promises as fsPromises } from "fs";
import { join } from "path";

async function lerFrases(rootDir) {
    try {
        const textsDir = join(rootDir, "media", "texts");
        const files = await fsPromises.readdir(textsDir);

        const frases = await Promise.all(
            files.map(async (file) => {
                const filePath = join(textsDir, file);
                const content = await fsPromises.readFile(filePath, "utf8");
                return content;
            })
        );

        return { frases };
    } catch (error) {
        console.error("Erro ao ler frases:", error);
        return { frases: [] };
    }
}

export function registerPhraseRoutes(app, { rootDir, MAX_MESSAGE_LENGTH }) {
    // Rota para obter todas as frases
    app.get("/frases", async (req, res) => {
        try {
            console.log("Buscando frases...");
            const data = await lerFrases(rootDir);
            console.log("Frases encontradas:", data.frases);
            res.json(data.frases);
        } catch (error) {
            console.error("Erro ao buscar frases:", error);
            res.status(500).json({ error: "Erro ao buscar frases" });
        }
    });

    // Rota para adicionar uma nova frase
    app.post("/frases", async (req, res) => {
        try {
            console.log("Recebendo nova frase:", req.body);
            const { frase } = req.body;
            if (!frase) {
                console.log("Frase não fornecida");
                return res.status(400).json({ error: "Frase é obrigatória" });
            }

            if (frase.length > MAX_MESSAGE_LENGTH) {
                console.log("Frase excede o tamanho máximo");
                return res.status(400).json({
                    error: `A frase deve ter no máximo ${MAX_MESSAGE_LENGTH} caracteres`,
                    maxLength: MAX_MESSAGE_LENGTH,
                });
            }

            const fileName = `frase_${Date.now()}.txt`;
            const filePath = join(rootDir, "media", "texts", fileName);
            await fsPromises.writeFile(filePath, frase);

            console.log("Frase adicionada com sucesso:", frase);
            res.status(201).json({
                message: "Frase adicionada com sucesso",
                frase,
            });
        } catch (error) {
            console.error("Erro ao adicionar frase:", error);
            res.status(500).json({ error: "Erro ao adicionar frase" });
        }
    });

    // Rota para remover uma frase
    app.delete("/frases/:index", async (req, res) => {
        try {
            const index = parseInt(req.params.index);
            const { frases } = await lerFrases(rootDir);

            if (index < 0 || index >= frases.length) {
                return res.status(404).json({ error: "Frase não encontrada" });
            }

            const textsDir = join(rootDir, "media", "texts");
            const files = await fsPromises.readdir(textsDir);
            const fileToDelete = files[index];

            if (fileToDelete) {
                await fsPromises.unlink(join(textsDir, fileToDelete));
            }

            res.json({ message: "Frase removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: "Erro ao remover frase" });
        }
    });
}
