import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const CLIENT_DIR = fs.existsSync(path.join(process.cwd(), 'apps/client'))
  ? path.join(process.cwd(), 'apps/client')
  : process.cwd();
const MESSAGES_DIR = path.join(CLIENT_DIR, 'messages');
const TARGET_LOCALES = ['zh-CN'];
const BASE_LOCALE = 'en';

const isDryRun = process.argv.includes('--dry-run');

async function syncTranslations() {
  console.log(`\n🌐 [i18n Sync Pipeline] Checking translations based on "${BASE_LOCALE}" (DryRun: ${isDryRun})...\n`);

  const basePath = path.join(MESSAGES_DIR, `${BASE_LOCALE}.json`);
  if (!fs.existsSync(basePath)) {
    console.error(`❌ Base translation file not found: ${basePath}`);
    process.exit(1);
  }

  const baseMessages: Record<string, string> = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
  const baseKeys = Object.keys(baseMessages);
  console.log(`📋 Base messages count (${BASE_LOCALE}): ${baseKeys.length} keys.\n`);

  let totalMissing = 0;

  for (const locale of TARGET_LOCALES) {
    const localePath = path.join(MESSAGES_DIR, `${locale}.json`);
    let localeMessages: Record<string, string> = {};
    if (fs.existsSync(localePath)) {
      localeMessages = JSON.parse(fs.readFileSync(localePath, 'utf-8'));
    }

    const missingKeys = baseKeys.filter((k) => {
      if (!(k in localeMessages)) return true;
      if (baseMessages[k].trim() !== '' && localeMessages[k].trim() === '') return true;
      return false;
    });
    const extraKeys = Object.keys(localeMessages).filter((k) => !(k in baseMessages));

    console.log(`🔹 [${locale}] Total: ${Object.keys(localeMessages).length} keys, Missing: ${missingKeys.length}, Extra: ${extraKeys.length}`);

    const hasChanges = extraKeys.length > 0 || missingKeys.length > 0;

    if (extraKeys.length > 0 && !isDryRun) {
      for (const k of extraKeys) {
        delete localeMessages[k];
      }
      console.log(`   🧹 Removed ${extraKeys.length} obsolete keys from ${locale}.json`);
    }

    if (missingKeys.length > 0) {
      totalMissing += missingKeys.length;
      console.log(`   ⚠️  Missing keys in ${locale}: ${missingKeys.join(', ')}`);

      if (!isDryRun) {
        for (const k of missingKeys) {
          localeMessages[k] = baseMessages[k];
        }
      }
    }

    if (hasChanges && !isDryRun) {
      fs.writeFileSync(localePath, JSON.stringify(localeMessages, null, 2) + '\n', 'utf-8');
      console.log(`   💾 Updated ${locale}.json.`);
    }

    if (!hasChanges) {
      console.log(`   ✅ 100% in sync with base locale!`);
    }
  }

  console.log(`\n==================================================`);
  if (totalMissing === 0) {
    console.log(`🎉 Core languages (zh-CN, en) are 100% synchronized!`);
  } else {
    console.log(`⚠️ Total missing translations across targets: ${totalMissing}`);
  }

  if (!isDryRun) {
    console.log(`\n🔨 Compiling Paraglide messages...`);
    try {
      execSync('npx @inlang/paraglide-js compile --project ./project.inlang --outdir ./src/paraglide', {
        cwd: CLIENT_DIR,
        stdio: 'inherit',
      });
      console.log(`✅ Paraglide compilation completed.`);
    } catch (err) {
      console.error(`❌ Paraglide compilation failed:`, err);
    }
  }
}

syncTranslations().catch(console.error);
