CREATE TYPE "CharacterCategory" AS ENUM ('ANIME', 'SERIES', 'MOVIE', 'STREAMER');
CREATE TYPE "CharacterRarity" AS ENUM ('COMMON', 'RARE', 'EPIC', 'LEGENDARY');

CREATE TABLE "Character" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "series" TEXT NOT NULL,
  "category" "CharacterCategory" NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "rarity" "CharacterRarity" NOT NULL,
  "popularityScore" DOUBLE PRECISION NOT NULL,
  "coinValue" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CharacterOwnership" (
  "id" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "ownerJid" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rollMessageId" TEXT,

  CONSTRAINT "CharacterOwnership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CharacterOwnership_characterId_groupId_key"
  ON "CharacterOwnership"("characterId", "groupId");

ALTER TABLE "CharacterOwnership"
  ADD CONSTRAINT "CharacterOwnership_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "Character"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "LinkedGroup" (
  "id" TEXT NOT NULL,
  "mainGroupId" TEXT NOT NULL,
  "gameGroupId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LinkedGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LinkedGroup_mainGroupId_key" ON "LinkedGroup"("mainGroupId");
CREATE UNIQUE INDEX "LinkedGroup_gameGroupId_key" ON "LinkedGroup"("gameGroupId");
