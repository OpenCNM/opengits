/**
 * prisma/seed.ts
 * 数据库基准种子：把 lib/tag-registry.ts 的 DEFAULT_TAG_REGISTRY_SEED
 * 幂等写入 TagRegistry 表（已存在者不覆盖，保留管理端的别名/启停编辑）。
 *
 * 运行方式：
 *   npx prisma db seed
 *   或 npm run seed:tags
 *   或 npm run seed:prompts:push -- <presetKey> [<presetKey>...]
 */
import { prisma } from '@/lib/db';
import { DEFAULT_TAG_REGISTRY_SEED } from '@/lib/tag-registry';
import { PromptRegistry } from '@/lib/prompt-registry';
import { ALL_PROMPT_PRESETS } from '@/lib/prompt-presets';

function parsePushArgs(argv: string[]): { isPushMode: boolean; keys: string[] } {
  let isPushMode = false;
  const keys: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--push') {
      isPushMode = true;
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i += 1;
        const k = argv[i].trim();
        if (k) keys.push(k);
      }
    } else if (arg.startsWith('--push=')) {
      isPushMode = true;
      const k = arg.slice('--push='.length).trim();
      if (k) keys.push(k);
    }
  }
  return { isPushMode, keys: Array.from(new Set(keys)) };
}

async function pushPromptPresets(keys: string[]): Promise<void> {
  if (keys.length === 0) {
    throw new Error('用法：npm run seed:prompts:push -- <presetKey> [<presetKey>...]');
  }
  const presetByKey = new Map(ALL_PROMPT_PRESETS.map((p) => [p.key, p]));
  const unknown = keys.filter((k) => !presetByKey.has(k));
  if (unknown.length > 0) {
    throw new Error(`未知提示词预设 key：${unknown.join(', ')}`);
  }

  const driftRows = await PromptRegistry.collectDrift();
  const driftByKey = new Map(driftRows.map((r) => [r.key, r]));

  for (const key of keys) {
    const preset = presetByKey.get(key)!;
    const row = driftByKey.get(key);
    if (row?.state === 'OK') {
      console.log(`⏭️  [SKIP] ${key} — 数据库默认版本 v${row.dbVersion} 已与代码基线一致，跳过。`);
      continue;
    }
    const { version } = await PromptRegistry.savePromptVersion(preset);
    PromptRegistry.invalidateCache(key);
    console.log(`✅ [PUSH] ${key} 已发布为默认版本 v${version}（旧版本行保留，可随时重新设为默认回滚）。`);
  }
}

async function main() {
  const { isPushMode, keys } = parsePushArgs(process.argv.slice(2));
  if (isPushMode) {
    await pushPromptPresets(keys);
    return;
  }

  let created = 0;
  let updated = 0;

  const seedValues = new Set(DEFAULT_TAG_REGISTRY_SEED.map((s) => s.value));

  for (const seed of DEFAULT_TAG_REGISTRY_SEED) {
    const existing = await prisma.tagRegistry.findUnique({
      where: { value: seed.value },
    });

    if (!existing) {
      await prisma.tagRegistry.create({
        data: {
          value: seed.value,
          kind: seed.kind,
          aliases: seed.aliases,
          source: 'seed',
          isActive: true,
        },
      });
      created += 1;
    } else {
      if (existing.source === 'seed') {
        await prisma.tagRegistry.update({
          where: { id: existing.id },
          data: {
            kind: seed.kind,
            aliases: seed.aliases,
            isActive: true,
          },
        });
        updated += 1;
      }
    }
  }

  // 对历史旧版 seed 分类但不再属于 10 大核心领域（如 Frontend、Backend 等已归并为别名者），将其置为 inactive
  const deprecatedSeedCategories = await prisma.tagRegistry.findMany({
    where: {
      source: 'seed',
      kind: 'CATEGORY',
      value: { notIn: Array.from(seedValues) },
      isActive: true,
    },
  });

  if (deprecatedSeedCategories.length > 0) {
    await prisma.tagRegistry.updateMany({
      where: {
        id: { in: deprecatedSeedCategories.map((c) => c.id) },
      },
      data: { isActive: false },
    });
    console.log(`  [归档] 停用旧版已归并不再独立的分类: ${deprecatedSeedCategories.map((c) => c.value).join(', ')}`);
  }

  console.log(`✅ 标签词表种子完成：共 ${DEFAULT_TAG_REGISTRY_SEED.length} 条（新建 ${created}，更新 ${updated}）`);

  // 提示词预设种子初始化（幂等：仅入库缺失预设，已有版本一律不触碰）
  const { createdKeys } = await PromptRegistry.seedMissingPresets();
  PromptRegistry.invalidateCache();
  console.log(
    `✅ 提示词预设种子完成：共 ${ALL_PROMPT_PRESETS.length} 个（新建 ${createdKeys.length}，原有保持 ${ALL_PROMPT_PRESETS.length - createdKeys.length}）`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
