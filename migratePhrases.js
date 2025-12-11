import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { saveMedia } from "./mediaManager.js";

async function migratePhrases() {
  try {
    // Lê o arquivo de frases em formato JSON
    const phrasesContent = await fs.readFile("frases.json", "utf8");
    const { frases } = JSON.parse(phrasesContent);

    console.log(`Encontradas ${frases.length} frases para migrar`);

    // Para cada frase, cria um arquivo temporário e salva usando o mediaManager
    for (const frase of frases) {
      // Cria um arquivo temporário com a frase
      const tempFilePath = join(__dirname, "temp_phrase.txt");
      await fs.writeFile(tempFilePath, frase);

      // Prepara o objeto de arquivo no formato esperado pelo mediaManager
      const fileObj = {
        originalname: `frase_${Date.now()}.txt`,
        path: tempFilePath,
      };

      // Salva usando o mediaManager
      await saveMedia(fileObj, "text");

      console.log(`Frase migrada: ${frase.substring(0, 50)}...`);
    }

    console.log("Migração concluída com sucesso!");
  } catch (error) {
    console.error("Erro durante a migração:", error);
  }
}

// Executa a migração
migratePhrases();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
