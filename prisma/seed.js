import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const ROLES = [
  { name: 'Super Admin', slug: 'super_admin' },
  { name: 'Bom Dia Admin', slug: 'bom_dia_admin' },
  { name: 'Miru Cadastro', slug: 'miru_cadastro' },
]
const ADMIN_EMAIL = 'felipegrego23@outlook.com'

async function main() {
  // Upsert roles
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { slug: r.slug },
      update: { name: r.name },
      create: { name: r.name, slug: r.slug },
    })
  }
  console.log('Seed: roles upserted')

  // Create initial admin user if no users exist
  const count = await prisma.user.count()
  if (count === 0) {
    const password = randomBytes(12).toString('base64url')
    const passwordHash = await bcrypt.hash(password, 10)
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: 'Felipe Struchel',
        passwordHash,
        active: true,
      },
    })
    console.log(`Seed: usuário criado — email: ${ADMIN_EMAIL} | senha: ${password}`)
  }

  // Assign super_admin to admin email
  const adminUser = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } })
  if (adminUser) {
    const superAdminRole = await prisma.role.findUnique({ where: { slug: 'super_admin' } })
    if (superAdminRole) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: adminUser.id, roleId: superAdminRole.id } },
        update: {},
        create: { userId: adminUser.id, roleId: superAdminRole.id },
      })
      console.log(`Seed: super_admin atribuído a ${ADMIN_EMAIL}`)
    }
  }
}

main()
  .catch((e) => { console.error('Seed error:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
