import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_FOLDER_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

export const MEDIA_TYPES = {
  TEXT: "text",
  IMAGE: "image",
  VIDEO: "video",
} as const;

export type MediaType = (typeof MEDIA_TYPES)[keyof typeof MEDIA_TYPES];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const DEFAULT_BASE = "media";
export const DAILY_BASE = "daily_vid";
export const TRIGGER_BASE = "media_triggers";

export function resolveBaseFolder(scope = "media"): string {
  if (scope === "daily") return DAILY_BASE;
  if (scope === "trigger") return TRIGGER_BASE;
  return DEFAULT_BASE;
}

export function getMediaDirs(baseFolder = DEFAULT_BASE): Record<MediaType, string> {
  return {
    [MEDIA_TYPES.TEXT]: join(__dirname, baseFolder, "texts"),
    [MEDIA_TYPES.IMAGE]: join(__dirname, baseFolder, "images"),
    [MEDIA_TYPES.VIDEO]: join(__dirname, baseFolder, "videos"),
  };
}

export async function initializeDirectories(
  baseFolder = DEFAULT_BASE
): Promise<Record<MediaType, string>> {
  const dirs = getMediaDirs(baseFolder);
  for (const dir of Object.values(dirs)) {
    await fs.mkdir(dir, { recursive: true });
    console.log(`Diretório criado/verificado: ${dir}`);
  }
  return dirs;
}

async function checkFileSize(filePath: string): Promise<void> {
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(
      `Arquivo muito grande. Tamanho máximo: ${MAX_FILE_SIZE / (1024 * 1024)}MB`
    );
  }
}

async function checkFolderSize(dir: string): Promise<void> {
  const files = await fs.readdir(dir);
  let totalSize = 0;
  for (const file of files) {
    const stats = await fs.stat(join(dir, file));
    totalSize += stats.size;
  }
  if (totalSize > MAX_FOLDER_SIZE) {
    throw new Error(
      `Pasta muito grande. Tamanho máximo: ${MAX_FOLDER_SIZE / (1024 * 1024 * 1024)}GB`
    );
  }
}

export interface MediaFile {
  path: string;
  type: string;
  fileName: string;
  baseFolder: string;
  originalname: string;
}

export async function saveMedia(
  file: { path: string; originalname: string },
  type: string,
  baseFolder = DEFAULT_BASE
): Promise<{ path: string; type: string; fileName: string; baseFolder: string }> {
  console.log("Iniciando salvamento de mídia:", {
    fileName: file.originalname,
    type,
    path: file.path,
  });

  const dirs = await initializeDirectories(baseFolder);
  const dir = (dirs as Record<string, string>)[type];
  const fileName = `${Date.now()}_${file.originalname}`;
  const filePath = join(dir, fileName);

  try {
    await checkFileSize(file.path);
    await checkFolderSize(dir);
    await fs.copyFile(file.path, filePath);
    await fs.unlink(file.path);
    return { path: filePath, type, fileName, baseFolder };
  } catch (error) {
    console.error("Erro ao salvar mídia:", error);
    try {
      await fs.unlink(file.path);
    } catch (cleanupError) {
      console.error("Erro ao remover arquivo temporário:", cleanupError);
    }
    throw error;
  }
}

export async function listAllMedia(
  baseFolder = DEFAULT_BASE
): Promise<Array<{ path: string; type: string; fileName: string; baseFolder: string }>> {
  const dirs = await initializeDirectories(baseFolder);
  const allMedia: Array<{ path: string; type: string; fileName: string; baseFolder: string }> = [];

  for (const [type, dir] of Object.entries(dirs)) {
    const files = await fs.readdir(dir);
    for (const file of files) {
      allMedia.push({ path: join(dir, file), type, fileName: file, baseFolder });
    }
  }
  return allMedia;
}

export async function getRandomMedia(
  baseFolder = DEFAULT_BASE
): Promise<{ path: string; type: string; fileName: string; baseFolder: string } | null> {
  const allMedia = await listAllMedia(baseFolder);
  if (allMedia.length === 0) return null;
  return allMedia[Math.floor(Math.random() * allMedia.length)];
}

export async function removeMedia(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    console.error("Erro ao remover arquivo:", error);
  }
}
