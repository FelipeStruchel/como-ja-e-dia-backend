-- AlterTable
ALTER TABLE "Trigger" ADD COLUMN     "groupId" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pokemonEnabled" BOOLEAN NOT NULL DEFAULT false,
    "confessionsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scheduledGreetingsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "triggersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "contextSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- Seed the current production group with every feature enabled (zero-downtime migration)
INSERT INTO "Group" ("id", "name", "pokemonEnabled", "confessionsEnabled", "scheduledGreetingsEnabled", "triggersEnabled", "contextSyncEnabled", "createdAt", "updatedAt")
VALUES (
  COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us'),
  'Grupo principal',
  true, true, true, true, true,
  now(), now()
)
ON CONFLICT ("id") DO NOTHING;

-- Backfill existing triggers to point at that same seeded group
UPDATE "Trigger" SET "groupId" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us') WHERE "groupId" = '';
