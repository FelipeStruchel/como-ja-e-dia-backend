import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'

const prisma = new PrismaClient()

async function main() {
  const count = await prisma.user.count()
  if (count > 0) return

  const password = randomBytes(12).toString('base64url')
  const passwordHash = await bcrypt.hash(password, 10)

  await prisma.user.create({
    data: {
      email: 'felipegrego23@outlook.com',
      name: 'Felipe Struchel',
      passwordHash,
      status: 'approved',
    },
  })

  console.log(`Seed: usuário criado — email: felipegrego23@outlook.com | senha: ${password}`)
}

main()
  .catch((e) => { console.error('Seed error:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
