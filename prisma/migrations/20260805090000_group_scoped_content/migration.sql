-- AlterTable
ALTER TABLE "Event" ADD COLUMN "groupId" TEXT;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN "groupId" TEXT;

-- AlterTable
ALTER TABLE "PersonaConfig" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PersonaConfig_groupId_key" ON "PersonaConfig"("groupId");

-- AlterTable
ALTER TABLE "Group" ADD COLUMN "eventsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing Events and Schedules to the main seeded group (zero-downtime, matches 20260730164008_add_group_table's convention)
UPDATE "Event" SET "groupId" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us') WHERE "groupId" IS NULL;
UPDATE "Schedule" SET "groupId" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us') WHERE "groupId" IS NULL;

-- The existing PersonaConfig row stays groupId = NULL deliberately: it keeps acting as the fallback
-- persona for any group without its own override, exactly as it does today. No backfill here.

-- Enable the new eventsEnabled flag for the main group (matches the other five flags there)
UPDATE "Group" SET "eventsEnabled" = true WHERE "id" = COALESCE(NULLIF(current_setting('app.group_id', true), ''), '120363339314665620@g.us');
