import { SUPPORTED_LANGUAGES, TRANSLATION_LANGUAGES } from './constants';

export const LANGUAGE_ALIASES: Record<string, string> = {
  'zh': 'zh-CN',
  'zh-cn': 'zh-CN', 'zh_cn': 'zh-CN', 'zhcn': 'zh-CN', 'zh-hans': 'zh-CN', 'zh_hans': 'zh-CN',
  'zho': 'zh-CN', 'cn': 'zh-CN', 'chinese': 'zh-CN', 'chinese simplified': 'zh-CN',
  'simplified chinese': 'zh-CN', 'hans': 'zh-CN', '中文': 'zh-CN', '简体中文': 'zh-CN', '简体': 'zh-CN', '简': 'zh-CN',
  'zh-tw': 'zh-TW', 'zh_tw': 'zh-TW', 'zhtw': 'zh-TW', 'zh-hant': 'zh-TW', 'zh_hant': 'zh-TW',
  'zh-hk': 'zh-TW', 'zh-mo': 'zh-TW', 'hant': 'zh-TW', 'traditional chinese': 'zh-TW',
  '繁体中文': 'zh-TW', '繁體中文': 'zh-TW', '繁体': 'zh-TW', '繁體': 'zh-TW', '繁': 'zh-TW', 'tw': 'zh-TW',
  'en': 'en', 'eng': 'en', 'english': 'en', '英文': 'en', '英语': 'en', '英語': 'en',
  'ja': 'ja', 'jpn': 'ja', 'japanese': 'ja', '日本語': 'ja', '日语': 'ja', '日語': 'ja', '日': 'ja',
  'ko': 'ko', 'kor': 'ko', 'korean': 'ko', '한국어': 'ko', '韩语': 'ko', '韓語': 'ko', '朝鲜语': 'ko',
  'ar': 'ar', 'ara': 'ar', 'arabic': 'ar', 'العربية': 'ar', '阿拉伯语': 'ar', '阿拉伯語': 'ar',
  'da': 'da', 'dan': 'da', 'danish': 'da', 'dansk': 'da', '丹麦语': 'da', '丹麥語': 'da',
  'de': 'de', 'deu': 'de', 'ger': 'de', 'german': 'de', 'deutsch': 'de', '德语': 'de', '德語': 'de',
  'es': 'es', 'spa': 'es', 'spanish': 'es', 'español': 'es', 'espanol': 'es', '西班牙语': 'es', '西班牙語': 'es',
  'fr': 'fr', 'fra': 'fr', 'fre': 'fr', 'french': 'fr', 'français': 'fr', 'francais': 'fr', '法语': 'fr', '法語': 'fr',
  'it': 'it', 'ita': 'it', 'italian': 'it', 'italiano': 'it', '意大利语': 'it', '意大利語': 'it',
  'ru': 'ru', 'rus': 'ru', 'russian': 'ru', 'русский': 'ru', '俄语': 'ru', '俄語': 'ru',
  'pt': 'pt', 'pt-br': 'pt-BR', 'pt_br': 'pt-BR', 'ptbr': 'pt-BR', 'pt-pt': 'pt-PT', 'por': 'pt',
  'vi': 'vi', 'vie': 'vi', 'vietnamese': 'vi', 'tiếng việt': 'vi', '越南语': 'vi', '越南語': 'vi',
  'th': 'th', 'tha': 'th', 'thai': 'th', 'ไทย': 'th', '泰语': 'th', '泰語': 'th',
  'id': 'id', 'ind': 'id', 'indonesian': 'id', 'bahasa indonesia': 'id', '印尼语': 'id',
  'tr': 'tr', 'tur': 'tr', 'turkish': 'tr', 'türkçe': 'tr', '土耳其语': 'tr',
  'nl': 'nl', 'nld': 'nl', 'dutch': 'nl', 'nederlands': 'nl', '荷兰语': 'nl', '荷蘭語': 'nl',
  'pl': 'pl', 'pol': 'pl', 'polish': 'pl', 'polski': 'pl', '波兰语': 'pl', '波蘭語': 'pl',
  'sv': 'sv', 'swe': 'sv', 'swedish': 'sv', 'svenska': 'sv', '瑞典语': 'sv', '瑞典語': 'sv',
  'uk': 'uk', 'ukr': 'uk', 'ukrainian': 'uk', 'українська': 'uk', '乌克兰语': 'uk', '烏克蘭語': 'uk',
  'cs': 'cs', 'ces': 'cs', 'czech': 'cs', 'čeština': 'cs', '捷克语': 'cs', '捷克語': 'cs',
  'fi': 'fi', 'fin': 'fi', 'finnish': 'fi', 'suomi': 'fi', '芬兰语': 'fi', '芬蘭語': 'fi',
  'no': 'no', 'nor': 'no', 'norwegian': 'no', 'norsk': 'no', '挪威语': 'no', '挪威語': 'no',
  'hu': 'hu', 'hun': 'hu', 'hungarian': 'hu', 'magyar': 'hu', '匈牙利语': 'hu', '匈牙利語': 'hu',
  'el': 'el', 'ell': 'el', 'greek': 'el', 'ελληνικά': 'el', '希腊语': 'el', '希臘語': 'el',
  'he': 'he', 'heb': 'he', 'hebrew': 'he', 'עברית': 'he', '希伯来语': 'he', '希伯來語': 'he',
  'hi': 'hi', 'hin': 'hi', 'hindi': 'hi', 'हिन्दी': 'hi', '印地语': 'hi', '印地語': 'hi',
  'ta': 'ta', 'tam': 'ta', 'tamil': 'ta', 'தமிழ்': 'ta', '泰米尔语': 'ta', '泰米爾語': 'ta',
  'ro': 'ro', 'ron': 'ro', 'romanian': 'ro', 'română': 'ro', '罗马尼亚语': 'ro',
  'bg': 'bg', 'bul': 'bg', 'bulgarian': 'bg', 'български': 'bg', '保加利亚语': 'bg',
  'ms': 'ms', 'msa': 'ms', 'malay': 'ms', 'bahasa melayu': 'ms', '马来语': 'ms', '馬來語': 'ms',
  'bn': 'bn', 'ben': 'bn', 'bengali': 'bn', 'বাংলা': 'bn', '孟加拉语': 'bn',
};

export const TRANSLATION_CONTAINER_NAMES: ReadonlySet<string> = new Set([
  'translations', 'translated', 'translated-content', 'translation', 'translations-content',
  'i18n', 'l10n', 'localization', 'localized', 'localisation', 'localised',
  'locales', 'locale', 'lang', 'langs', 'language', 'languages', 'intl', 'multilingual',
  '多语言', '翻译', '译文', '譯文',
]);

export function detectLangFromPath(path: string): string | null {
  const clean = path.replace(/\/+$/, '');
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1];
  const whole = normalizeLocale(last);
  if (whole) return whole;

  const tokens = last.split(/[-_]/);
  for (const token of tokens) {
    if (TRANSLATION_CONTAINER_NAMES.has(token.toLowerCase())) continue;
    const norm = normalizeLocale(token);
    if (norm) return norm;
  }

  if (segments.length >= 2 && TRANSLATION_CONTAINER_NAMES.has(last.toLowerCase())) {
    const prev = segments[segments.length - 2];
    const prevTokens = prev.split(/[-_]/);
    for (const token of prevTokens) {
      if (TRANSLATION_CONTAINER_NAMES.has(token.toLowerCase())) continue;
      const norm = normalizeLocale(token);
      if (norm) return norm;
    }
  }

  return null;
}

export function normalizeLocale(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  const alias = LANGUAGE_ALIASES[lowered];
  if (alias) return alias;

  const isoMatch = lowered.match(/^([a-z]{2,3})(?:[-_]([a-z]{2,4}))?$/);
  if (!isoMatch) return null;
  const base = isoMatch[1];
  const region = isoMatch[2];
  if (!region) return base;
  if (base === 'zh') {
    if (['cn', 'sg', 'hans', 'simp'].includes(region)) return 'zh-CN';
    if (['tw', 'hk', 'mo', 'hant', 'trad'].includes(region)) return 'zh-TW';
    return `zh-${titleCaseRegion(region)}`;
  }
  return `${base}-${titleCaseRegion(region)}`;
}

function titleCaseRegion(region: string): string {
  return region.length === 2 ? region.toUpperCase() : region[0].toUpperCase() + region.slice(1);
}

export function langDisplayName(code: string | null | undefined): string {
  if (!code) return '';
  const found = SUPPORTED_LANGUAGES.find(
    (l) => l.code.toLowerCase() === String(code).toLowerCase()
  );
  if (found) return found.name;
  return String(code);
}

