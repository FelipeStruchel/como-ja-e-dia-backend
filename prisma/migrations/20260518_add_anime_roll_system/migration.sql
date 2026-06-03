-- Anime Roll System: new enums, models, polymorphic CharacterOwnership

-- New enums
CREATE TYPE "CharacterGender" AS ENUM ('UNKNOWN', 'MALE', 'FEMALE');
CREATE TYPE "CharacterSource" AS ENUM ('MANUAL', 'ANILIST');
CREATE TYPE "ExternalSource" AS ENUM ('ANILIST');
CREATE TYPE "MetaGender" AS ENUM ('ALL', 'MALE', 'FEMALE');

-- Migrate existing data before changing CharacterOwnership
ALTER TABLE "CharacterOwnership" ADD COLUMN "characterRef" TEXT;
ALTER TABLE "CharacterOwnership" ADD COLUMN "source" "CharacterSource" NOT NULL DEFAULT 'MANUAL';
UPDATE "CharacterOwnership" SET "characterRef" = "characterId" WHERE "characterRef" IS NULL;
ALTER TABLE "CharacterOwnership" ALTER COLUMN "characterRef" SET NOT NULL;

-- Replace the old unique constraint with the new polymorphic one
ALTER TABLE "CharacterOwnership" DROP CONSTRAINT IF EXISTS "CharacterOwnership_characterId_groupId_key";
ALTER TABLE "CharacterOwnership" DROP CONSTRAINT IF EXISTS "CharacterOwnership_characterId_fkey";
ALTER TABLE "CharacterOwnership" DROP COLUMN IF EXISTS "characterId";

CREATE UNIQUE INDEX "CharacterOwnership_characterRef_source_groupId_key"
  ON "CharacterOwnership"("characterRef", "source", "groupId");

-- Add gender column to Character
ALTER TABLE "Character" ADD COLUMN "gender" "CharacterGender" NOT NULL DEFAULT 'UNKNOWN';

-- New tables
CREATE TABLE "AnilistCharacter" (
  "id" TEXT NOT NULL,
  "externalId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "gender" "CharacterGender" NOT NULL DEFAULT 'UNKNOWN',
  "series" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "sourceImageUrl" TEXT NOT NULL,
  "popularityScore" DOUBLE PRECISION NOT NULL,
  "rarity" "CharacterRarity" NOT NULL,
  "coinValue" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AnilistCharacter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnilistCharacter_externalId_key" ON "AnilistCharacter"("externalId");

CREATE TABLE "CharacterSourceMeta" (
  "id" TEXT NOT NULL,
  "source" "ExternalSource" NOT NULL,
  "gender" "MetaGender" NOT NULL,
  "totalCount" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CharacterSourceMeta_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CharacterSourceMeta_source_gender_key" ON "CharacterSourceMeta"("source", "gender");

CREATE TABLE "CharacterGroupImage" (
  "id" TEXT NOT NULL,
  "characterRef" TEXT NOT NULL,
  "source" "CharacterSource" NOT NULL,
  "groupId" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CharacterGroupImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CharacterGroupImage_characterRef_source_groupId_key"
  ON "CharacterGroupImage"("characterRef", "source", "groupId");
