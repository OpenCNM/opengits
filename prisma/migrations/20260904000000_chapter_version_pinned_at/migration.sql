-- 作者钦定推荐正典（pin）：维护者将某译本一键设为推荐正典的时间戳。
-- pinnedAt 非空 = 作者钦定生效，maybeFlipCanonical 对钦定正典免疫（作者裁决 > 社区投票）。
ALTER TABLE "ChapterVersion" ADD COLUMN "pinnedAt" TIMESTAMP(3);
