import { existsSync, createReadStream, mkdirSync } from "fs";
import { promises as fsPromises } from "fs";
import { join, basename } from "path";
import multer from "multer";
import mime from "mime-types";
import { resolveBaseFolder } from "../mediaManager.js";

function buildUrls(type, filename, scope) {
    const baseInternal = (process.env.MEDIA_BASE_URL || "http://backend:3000").replace(/\/+$/, "");
    const basePublic = (process.env.BACKEND_PUBLIC_URL || baseInternal).replace(/\/+$/, "");
    if (scope === "daily") {
        const rel = `/daily_vid/${filename}`;
        return {
            url: `${baseInternal}${rel}`,
            urlPublic: `${basePublic}${rel}`,
        };
    }
    const rel = `/media/${type}/${filename}${scope === "trigger" ? "?scope=trigger" : ""}`;
    return {
        url: `${baseInternal}${rel}`,
        urlPublic: `${basePublic}${rel}`,
    };
}

export function createUploadMiddleware() {
    const storage = multer.diskStorage({
        destination: function (_req, _file, cb) {
            const tempDir = join(process.cwd(), "temp");
            mkdirSync(tempDir, { recursive: true });
            cb(null, tempDir);
        },
        filename: function (_req, file, cb) {
            const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
            const ext = file.originalname.split(".").pop();
            cb(null, file.fieldname + "-" + uniqueSuffix + "." + ext);
        },
    });

    const fileFilter = (_req, file, cb) => {
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
            const scope = (req.body.scope || req.query.scope || "media").toString();

            if (!req.file) {
                return res.status(400).json({ error: "Nenhum arquivo enviado" });
            }

            const type = req.body.type || MEDIA_TYPES.TEXT;
            if (!Object.values(MEDIA_TYPES).includes(type)) {
                return res.status(400).json({ error: "Tipo de mídia inválido" });
            }

            const baseFolder = resolveBaseFolder(scope);
            const media = await saveMedia(req.file, type, baseFolder);
            const filename = basename(media.path);
            const urls = buildUrls(media.type, filename, scope);

            res.setHeader("Content-Type", "application/json");
            res.status(201).json({
                message: "Mídia salva com sucesso",
                media: { ...media, url: urls.url, urlPublic: urls.urlPublic },
            });
        } catch (error) {
            res.setHeader("Content-Type", "application/json");
            res.status(500).json({ error: error.message });
        }
    });

    app.get("/media/:type/:filename", (req, res) => {
        const { type, filename } = req.params;
        const scope = (req.query.scope || "media").toString();
        const baseFolder = resolveBaseFolder(scope);
        const pluralType = type.endsWith("s") ? type : `${type}s`;
        const filePath = join(process.cwd(), baseFolder, pluralType, filename);

        if (!existsSync(filePath)) {
            return res.status(404).json({ error: "Arquivo não encontrado" });
        }

        const contentType = mime.lookup(filename) || "application/octet-stream";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

        const fileStream = createReadStream(filePath);

        fileStream.on("error", () => {
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
            const type = req.query.type;
            const scope = (req.query.scope || "media").toString();
            const baseFolder = resolveBaseFolder(scope);
            if (type && !Object.values(MEDIA_TYPES).includes(type)) {
                return res.status(400).json({ error: "Tipo de mídia inválido" });
            }

            let media = await listAllMedia(baseFolder);

            if (type) {
                media = media.filter((item) => item.type === type);
            } else {
                media = media.filter((item) => item.type !== MEDIA_TYPES.TEXT);
            }

            const mediaWithUrls = media.map((item) => {
                const urls = buildUrls(item.type, basename(item.path), scope);
                return {
                    ...item,
                    url: urls.url,
                    urlPublic: urls.urlPublic,
                };
            });
            res.json(mediaWithUrls);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete("/media/:type/:filename", async (req, res) => {
        try {
            const { type, filename } = req.params;
            const scope = (req.query.scope || "media").toString();
            const baseFolder = resolveBaseFolder(scope);
            const pluralType = type.endsWith("s") ? type : `${type}s`;
            const filePath = join(process.cwd(), baseFolder, pluralType, filename);

            if (!existsSync(filePath)) {
                return res.status(404).json({ error: "Arquivo não encontrado" });
            }

            await fsPromises.unlink(filePath);
            res.json({ message: "Mídia removida com sucesso" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
}
