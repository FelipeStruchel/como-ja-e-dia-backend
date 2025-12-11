import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WhatsAppWebPkg from "whatsapp-web.js";
const { MessageMedia } = WhatsAppWebPkg;

// Configurações
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_FOLDER_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
const MAX_VIDEO_DURATION = 90; // 90 segundos (1.5 minutos)
const MEDIA_TYPES = {
    TEXT: "text",
    IMAGE: "image",
    VIDEO: "video",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_BASE = "media";

function getMediaDirs(baseFolder = DEFAULT_BASE) {
    return {
        [MEDIA_TYPES.TEXT]: join(__dirname, baseFolder, "texts"),
        [MEDIA_TYPES.IMAGE]: join(__dirname, baseFolder, "images"),
        [MEDIA_TYPES.VIDEO]: join(__dirname, baseFolder, "videos"),
    };
}

// Criar diretórios se não existirem
async function initializeDirectories(baseFolder = DEFAULT_BASE) {
    const dirs = getMediaDirs(baseFolder);
    for (const dir of Object.values(dirs)) {
        await fs.mkdir(dir, { recursive: true });
        // eslint-disable-next-line no-console
        console.log(`Diretório criado/verificado: ${dir}`);
    }
    return dirs;
}

// Verificar tamanho do arquivo
async function checkFileSize(filePath) {
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
            `Arquivo muito grande. Tamanho máximo: ${MAX_FILE_SIZE / (1024 * 1024)}MB`
        );
    }
}

// Verificar tamanho da pasta
async function checkFolderSize(dir) {
    const files = await fs.readdir(dir);
    let totalSize = 0;

    for (const file of files) {
        const stats = await fs.stat(join(dir, file));
        totalSize += stats.size;
    }

    if (totalSize > MAX_FOLDER_SIZE) {
        throw new Error(
            `Pasta muito grande. Tamanho máximo: ${
                MAX_FOLDER_SIZE / (1024 * 1024 * 1024)
            }GB`
        );
    }
}

// Salvar arquivo de mídia
async function saveMedia(file, type, baseFolder = DEFAULT_BASE) {
    // eslint-disable-next-line no-console
    console.log("Iniciando salvamento de mídia:", {
        fileName: file.originalname,
        type,
        path: file.path,
    });

    const dirs = await initializeDirectories(baseFolder);

    const dir = dirs[type];
    const fileName = `${Date.now()}_${file.originalname}`;
    const filePath = join(dir, fileName);

    try {
        await checkFileSize(file.path);
        await checkFolderSize(dir);

        await fs.copyFile(file.path, filePath);
        await fs.unlink(file.path);

        return {
            path: filePath,
            type,
            fileName,
            baseFolder,
        };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Erro ao salvar mídia:", error);
        try {
            await fs.unlink(file.path);
        } catch (cleanupError) {
            // eslint-disable-next-line no-console
            console.error("Erro ao remover arquivo temporário:", cleanupError);
        }
        throw error;
    }
}

// Listar todas as mídias
async function listAllMedia(baseFolder = DEFAULT_BASE) {
    const dirs = await initializeDirectories(baseFolder);

    const allMedia = [];

    for (const [type, dir] of Object.entries(dirs)) {
        const files = await fs.readdir(dir);

        for (const file of files) {
            const filePath = join(dir, file);
            allMedia.push({
                path: filePath,
                type,
                fileName: file,
                baseFolder,
            });
        }
    }

    return allMedia;
}

// Obter mídia aleatória
async function getRandomMedia(baseFolder = DEFAULT_BASE) {
    const allMedia = await listAllMedia(baseFolder);
    if (allMedia.length === 0) {
        return null;
    }
    return allMedia[Math.floor(Math.random() * allMedia.length)];
}

// Remover mídia após envio
async function removeMedia(filePath) {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Erro ao remover arquivo:", error);
    }
}

// Preparar mídia para envio no WhatsApp
async function prepareMediaForWhatsApp(media) {
    if (media.type === MEDIA_TYPES.TEXT) {
        const content = await fs.readFile(media.path, "utf8");
        return {
            type: "text",
            content,
        };
    } else {
        return MessageMedia.fromFilePath(media.path);
    }
}

export {
    MEDIA_TYPES,
    saveMedia,
    getRandomMedia,
    removeMedia,
    prepareMediaForWhatsApp,
    checkFileSize,
    checkFolderSize,
    listAllMedia,
    DEFAULT_BASE,
    getMediaDirs,
    initializeDirectories,
};
