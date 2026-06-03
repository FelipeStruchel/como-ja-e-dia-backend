import path from 'path'
import { fileURLToPath } from 'url'
import { mkdir, writeFile, access } from 'fs/promises'
import { constants } from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const IMAGE_DIR = path.join(__dirname, '../data/character-images/anilist')

export function localImagePath(externalId: number): string {
  return `/characters/images/anilist/${externalId}.jpg`
}

export function localImageFilePath(externalId: number): string {
  return path.join(IMAGE_DIR, `${externalId}.jpg`)
}

export async function imageExistsLocally(externalId: number): Promise<boolean> {
  try {
    await access(localImageFilePath(externalId), constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function downloadAndSaveImage(
  externalId: number,
  sourceImageUrl: string,
): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true })
  const res = await fetch(sourceImageUrl)
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${sourceImageUrl}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  await writeFile(localImageFilePath(externalId), buffer)
}
