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

// Diretórios para cada tipo de mídia
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MEDIA_DIRS = {
  [MEDIA_TYPES.TEXT]: join(__dirname, "media", "texts"),
  [MEDIA_TYPES.IMAGE]: join(__dirname, "media", "images"),
  [MEDIA_TYPES.VIDEO]: join(__dirname, "media", "videos"),
};

// Criar diretórios se não existirem
async function initializeDirectories() {
  for (const dir of Object.values(MEDIA_DIRS)) {
    await fs.mkdir(dir, { recursive: true });
    console.log(`Diretório criado/verificado: ${dir}`);
  }
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
async function saveMedia(file, type) {
  console.log("Iniciando salvamento de mídia:", {
    fileName: file.originalname,
    type: type,
    path: file.path,
  });

  await initializeDirectories();

  const dir = MEDIA_DIRS[type];
  const fileName = `${Date.now()}_${file.originalname}`;
  const filePath = join(dir, fileName);

  console.log("Caminhos configurados:", {
    dir: dir,
    fileName: fileName,
    filePath: filePath,
  });

  try {
    await checkFileSize(file.path);
    await checkFolderSize(dir);

    console.log("Copiando arquivo para:", filePath);
    await fs.copyFile(file.path, filePath);
    console.log("Arquivo copiado com sucesso");

    console.log("Removendo arquivo temporário:", file.path);
    await fs.unlink(file.path);
    console.log("Arquivo temporário removido");

    return {
      path: filePath,
      type,
      fileName,
    };
  } catch (error) {
    console.error("Erro ao salvar mídia:", error);
    // Tentar remover o arquivo temporário em caso de erro
    try {
      await fs.unlink(file.path);
    } catch (cleanupError) {
      console.error("Erro ao remover arquivo temporário:", cleanupError);
    }
    throw error;
  }
}

// Listar todas as mídias
async function listAllMedia() {
  await initializeDirectories();

  const allMedia = [];

  for (const [type, dir] of Object.entries(MEDIA_DIRS)) {
    const files = await fs.readdir(dir);

    for (const file of files) {
      const filePath = join(dir, file);
      allMedia.push({
        path: filePath,
        type,
        fileName: file,
      });
    }
  }

  return allMedia;
}

// Obter mídia aleatória
async function getRandomMedia() {
  const allMedia = await listAllMedia();

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
};
