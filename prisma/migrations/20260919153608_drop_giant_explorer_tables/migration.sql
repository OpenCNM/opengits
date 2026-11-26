/*
  Warnings:

  - You are about to drop the `ArchitectureOverview` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModuleMapEntry` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ArchitectureOverview" DROP CONSTRAINT "ArchitectureOverview_outlineId_fkey";

-- DropForeignKey
ALTER TABLE "ArchitectureOverview" DROP CONSTRAINT "ArchitectureOverview_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "ModuleMapEntry" DROP CONSTRAINT "ModuleMapEntry_outlineId_fkey";

-- DropForeignKey
ALTER TABLE "ModuleMapEntry" DROP CONSTRAINT "ModuleMapEntry_repositoryId_fkey";

-- AlterTable
ALTER TABLE "PlatformCreditsConfig" ALTER COLUMN "publicDiscountMultiplier" SET DEFAULT -1.0;

-- DropTable
DROP TABLE "ArchitectureOverview";

-- DropTable
DROP TABLE "ModuleMapEntry";
