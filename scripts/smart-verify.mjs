import { execSync } from 'child_process';
import path from 'path';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

function getChangedFiles() {
  try {
    const output = execSync('git status --porcelain', { encoding: 'utf8' });
    return output
      .split('\n')
      .map(line => line.replace(/^[\s\w?]{1,3}\s+/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function classifyTier(files) {
  if (files.length === 0) return { tier: 'tier1', hasGo: false, hasSchema: false };

  let hasEngine = false;
  let hasApiOrLib = false;
  let hasSchema = false;
  let hasGo = false;

  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');

    if (normalized.includes('/engine/') || normalized.startsWith('src/engine/')) {
      hasEngine = true;
    } else if (normalized.startsWith('prisma/') || normalized.endsWith('schema.prisma')) {
      hasSchema = true;
    } else if (normalized.startsWith('services/worker-sidecar/') || normalized.endsWith('.go')) {
      hasGo = true;
    } else if (normalized.includes('/app/api/') || normalized.includes('/lib/') || normalized.startsWith('src/app/api/') || normalized.startsWith('src/lib/')) {
      hasApiOrLib = true;
    }
  }

  if (hasEngine || hasGo) {
    return { tier: 'tier3', hasGo, hasSchema };
  }
  if (hasSchema) {
    return { tier: 'tier3', hasGo, hasSchema };
  }
  if (hasApiOrLib) {
    return { tier: 'tier2', hasGo, hasSchema };
  }
  return { tier: 'tier1', hasGo, hasSchema };
}

const TSC_CMD = 'npx tsc --noEmit --project apps/client/tsconfig.json';

async function main() {
  const startTime = Date.now();
  const forceBuild = process.argv.includes('--build') || process.argv.includes('--release');
  const forceFull = process.argv.includes('--full');
  const changedFiles = getChangedFiles();
  let { tier, hasGo, hasSchema } = classifyTier(changedFiles);

  console.log('\n🤖 🧠 [Smart Verify Gate] Analyzing changed files...');
  console.log(`   Changed Files (${changedFiles.length}):`, changedFiles.slice(0, 5).join(', ') + (changedFiles.length > 5 ? '...' : ''));

  if (tier === 'tier1' && !forceFull) {
    console.log('   🟢 Classification: Tier 1 (UI / Style / Component / Text tweak)');
    console.log('   ⚡ Executing Fast Gate (TSC + Anti-Hardcode Linter)...\n');

    run(TSC_CMD);
    run('node scripts/lint-anti-hardcode.mjs');
    run('node scripts/lint-swallow.mjs');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 [Smart Verify PASS] Fast UI Gate completed cleanly in ${elapsed}s! (Skipped heavy browser & AST suite)`);
  } else if (tier === 'tier2' && !forceFull) {
    console.log('   🟡 Classification: Tier 2 (API Route / Feature Logic)');
    console.log('   ⚡ Executing Feature Gate (TSC + Linter + Unit Tests)...\n');

    run(TSC_CMD);
    run('node scripts/lint-anti-hardcode.mjs');
    run('node scripts/lint-swallow.mjs');
    run('npx vitest run tests/unit');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 [Smart Verify PASS] Feature Gate completed cleanly in ${elapsed}s!`);
  } else {
    console.log('   🔴 Classification: Tier 3 (Core Engine / Database Schema / Heavy Refactor)');
    console.log('   🛡️ Executing Full Verification Suite...\n');

    run('node scripts/lint-anti-hardcode.mjs');
    run('node scripts/lint-swallow.mjs');
    run(TSC_CMD);
    if (process.argv.includes('--smoke') || forceFull) {
      console.log('   🧪 Running Full Test Suite (unit + integration)...');
      run('npm run test');
    } else {
      console.log('   ⚡ Running Fast Unit Test Gate...');
      run('npx vitest run tests/unit');
    }
    if (hasGo || hasSchema) {
      console.log('   🐹 Running Go Worker Sidecar Tests (go test ./...)...');
      run('go test ./...', { cwd: path.join(process.cwd(), 'services', 'worker-sidecar') });
    }
    if (forceBuild || forceFull) {
      console.log('   🏗️ Executing Next.js Production Build (npm run build)...');
      run('npm run build');
    } else {
      console.log('   ⚡ Skipping heavy next build (pass --build to include production bundle compile)');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 [Smart Verify PASS] Full Verification Suite completed cleanly in ${elapsed}s!`);
  }
}

main();
