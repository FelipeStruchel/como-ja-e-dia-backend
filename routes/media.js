import { existsSync, createReadStream } from "fs";
import { promises as fsPromises } from "fs";
import { join, basename } from "path";
import multer from "multer";

export function createUploadMiddleware() {
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, "temp/");
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
            const ext = file.originalname.split(".").pop();
            cb(null, file.fieldname + "-" + uniqueSuffix + "." + ext);
        },
    });

    const fileFilter = (req, file, cb) => {
        const allowedImageTypes = ["image/jpeg", "image/png", "image/gif"];
        const allowedVideoTypes = [
            "video/mp4",
            "video/quicktime",
            "video/x-msvideo",
            "video/x-matroska",
        ];

        if (
            file.mimetype.startsWith("image/") &&
            allowedImageTypes.includes(file.mimetype)
        ) {
            cb(null, true);
        } else if (
            file.mimetype.startsWith("video/") &&
            allowedVideoTypes.includes(file.mimetype)
        ) {
            cb(null, true);
        } else {
            cb(
                new Error(
                    "Tipo de arquivo não permitido. Use apenas imagens (JPG, PNG, GIF) ou vídeos (MP4, MOV, AVI, MKV)."
                ),
                false
            );
        }
    };

    return multer({
        storage,
        fileFilter,
        limits: {
            fileSize: 100 * 1024 * 1024, // 100MB
        },
    });
}

export function registerMediaRoutes(app, { MEDIA_TYPES, saveMedia, listAllMedia }) {
    const upload = createUploadMiddleware();

    app.post("/media", upload.single("file"), async (req, res) => {
        try {
            console.log("Recebendo upload de mídia:", {
                file: req.file,
                body: req.body,
                headers: req.headers,
            });

            if (!req.file) {
                console.log("Nenhum arquivo enviado");
                return res.status(400).json({ error: "Nenhum arquivo enviado" });
            }

            const type = req.body.type || MEDIA_TYPES.TEXT;
            if (!Object.values(MEDIA_TYPES).includes(type)) {
                console.log("Tipo de mídia inválido:", type);
                return res.status(400).json({ error: "Tipo de mídia inválido" });
            }

            console.log("Salvando mídia do tipo:", type);
            const media = await saveMedia(req.file, type);
            console.log("Mídia salva com sucesso:", media);

            res.setHeader("Content-Type", "application/json");
            res.status(201).json({ message: "Mídia salva com sucesso", media });
        } catch (error) {
            console.error("Erro ao salvar mídia:", error);
            res.setHeader("Content-Type", "application/json");
            res.status(500).json({ error: error.message });
        }
    });

    app.get("/media/:type/:filename", (req, res) => {
        const { type, filename } = req.params;
        const pluralType = type.endsWith("s") ? type : `${type}s`;
        const filePath = join(process.cwd(), "media", pluralType, filename);

        console.log("Tentando servir arquivo:", filePath);

        if (!existsSync(filePath)) {
            console.error(`Arquivo não encontrado: ${filePath}`);
            return res.status(404).json({ error: "Arquivo não encontrado" });
        }

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

        const fileStream = createReadStream(filePath);

        fileStream.on("error", (error) => {
            console.error(`Erro ao ler arquivo ${filePath}:`, error);
            if (!res.headersSent) {
                res.status(500).json({ error: "Erro ao ler arquivo" });
            }
        });

        req.on("aborted", () => {
            fileStream.destroy();
        });

        fileStream.pipe(res);
    });

    app.get("/media", async (req, res) => {
        try {
            console.log("Buscando mídias...");
            const type = req.query.type;
            if (type && !Object.values(MEDIA_TYPES).includes(type)) {
                return res.status(400).json({ error: "Tipo de mídia inválido" });
            }

            let media = await listAllMedia();

            if (type) {
                media = media.filter((item) => item.type === type);
            } else {
                media = media.filter((item) => item.type !== MEDIA_TYPES.TEXT);
            }
            console.log("Mídias encontradas:", media);
            const mediaWithUrls = media.map((item) => ({
                ...item,
                url: `/media/${item.type}/${basename(item.path)}`,
            }));
            console.log("Mídias com URLs:", mediaWithUrls);
            res.json(mediaWithUrls);
        } catch (error) {
            console.error("Erro ao listar mídias:", error);
            res.status(500).json({ error: error.message });
        }
    });

    app.delete("/media/:type/:filename", async (req, res) => {
        try {
            const { type, filename } = req.params;
            const pluralType = type.endsWith("s") ? type : `${type}s`;
            const filePath = join(process.cwd(), "media", pluralType, filename);

            console.log("Tentando deletar arquivo:", filePath);

            if (!existsSync(filePath)) {
                console.error(`Arquivo não encontrado: ${filePath}`);
                return res.status(404).json({ error: "Arquivo não encontrado" });
            }

            await fsPromises.unlink(filePath);
            console.log(`Arquivo removido: ${filePath}`);

            res.json({ message: "Mídia removida com sucesso" });
        } catch (error) {
            console.error("Erro ao remover mídia:", error);
            res.status(500).json({ error: error.message });
        }
    });
}
