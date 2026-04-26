// como-ja-e-dia-backend/scripts/generate-pokemon-weights.ts
import axios from 'axios'
import { writeFile, mkdir } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOTAL = 1025
const CONCURRENCY = 20

interface Weight { id: number; captureRate: number }

async function fetchCaptureRate(id: number, attempts = 3): Promise<Weight> {
  try {
    const res = await axios.get<{ capture_rate: number }>(
      `https://pokeapi.co/api/v2/pokemon-species/${id}`,
      { timeout: 15_000 }
    )
    return { id, captureRate: res.data.capture_rate }
  } catch (err) {
    if (attempts <= 1) throw err
    await new Promise((r) => setTimeout(r, 1000 * (4 - attempts)))
    return fetchCaptureRate(id, attempts - 1)
  }
}

const weights: Weight[] = []

for (let i = 1; i <= TOTAL; i += CONCURRENCY) {
  const batch = Array.from(
    { length: Math.min(CONCURRENCY, TOTAL - i + 1) },
    (_, j) => i + j
  )
  const results = await Promise.all(batch.map(fetchCaptureRate))
  weights.push(...results)
  process.stdout.write(`\rProgress: ${Math.min(i + CONCURRENCY - 1, TOTAL)}/${TOTAL}`)
}

console.log('')

weights.sort((a, b) => a.id - b.id)

const outDir = path.join(__dirname, '../data')
await mkdir(outDir, { recursive: true })
const outPath = path.join(outDir, 'pokemon-weights.json')
await writeFile(outPath, JSON.stringify(weights, null, 2))
console.log(`Escrito ${weights.length} entradas em ${outPath}`)
