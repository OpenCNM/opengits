/**
 * apps/client/src/lib/wasm/binary-search-engine.ts
 *
 * Client-side High-Performance In-Memory Binary Search Engine.
 *
 * Capabilities:
 * - Unpacks OGIS v1 binary index into compact TypedArray structures (Uint32Array + Uint16Array)
 * - Lazy String Decoding: StringPool maintains native byte slice; strings are only decoded for Top-K results
 * - Instant sub-millisecond BM25 ranking (k1=1.2, b=0.75)
 * - Heading & title semantic weighting (1.2x boost)
 * - Prefix search-as-you-type expansion
 * - 0 network roundtrips once index is in memory/disk cache
 * - Eliminates 100,000+ JS heap object allocations & GC pauses
 */

import zlib from 'node:zlib';
import type { SearchResultItem } from '@/app/api/search/route';
import {
  unpackSearchIndex,
  type SearchIndexSnapshot,
  type UnpackedChunkRecord,
} from '@/lib/search/binary-index-packer';
import { tokenizeSearchText } from '@/lib/search/binary-index-tokenizer';

/** slugify 导出仅供对拍测试（锚点与 Go mdpat.Slugify 锁步） */
export function slugify(text: string): string {
  const trimmed = text.trim();
  const slug = trimmed
    .toLowerCase()
    // CJK 宽字符类（汉 + 假名 + 谚文 + 扩展区 + 长音符ー + 叠字符々），与 Go ogis/search.mdpat.CJKScriptClass 锁步
    .replace(/[^\w\u4e00-\u9fa5\u3040-\u30ff\u30fc\u3005\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 空串漂移防御（BUG-03 残留）：非空白输入清洗为空时回退 h-<FNV-1a64>，
  // 与 Go mdpat.Slugify 完全一致——浏览器快道与网络路径锚点不再分叉
  if (slug === '' && trimmed !== '') return `h-${fnv1a64Hex(trimmed)}`;
  return slug;
}

/** FNV-1a 64 位（Go mdpat.Fnv64aHex 逐位一致；TS 目标 < ES2020 无 BigInt，
 * 以 16-bit limbs 实现：offset basis 0xcbf29ce484222325，prime 0x100000001b3） */
function fnv1a64Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  const p0 = 0x01b3;
  const p2 = 0x0100; // prime limbs LE: [0x01b3, 0, 0x0100, 0]
  for (let i = 0; i < bytes.length; i++) {
    h0 = (h0 ^ bytes[i]) & 0xffff;
    let r0 = h0 * p0;
    let r1 = h1 * p0;
    let r2 = h2 * p0 + h0 * p2;
    let r3 = h3 * p0 + h1 * p2;
    const c0 = Math.floor(r0 / 0x10000);
    r0 &= 0xffff;
    r1 += c0;
    const c1 = Math.floor(r1 / 0x10000);
    r1 &= 0xffff;
    r2 += c1;
    const c2 = Math.floor(r2 / 0x10000);
    r2 &= 0xffff;
    r3 = (r3 + c2) & 0xffff; // ≥2^64 的卷积项丢弃（mod 2^64）
    h0 = r0;
    h1 = r1;
    h2 = r2;
    h3 = r3;
  }
  const hex = [h3, h2, h1, h0].map((n) => n.toString(16).padStart(4, '0')).join('');
  return hex.replace(/^0+(?=.)/, ''); // Go strconv.FormatUint 无前导零
}

/**
 * 零拷贝与零额外堆对象分配的大小写折叠字节切片子串查找（兼容 ASCII 与 UTF-8 多字节字符）。
 */
function bytesContainsFold(
  haystack: Uint8Array,
  start: number,
  len: number,
  needle: Uint8Array,
): boolean {
  const nLen = needle.length;
  if (nLen === 0) return true;
  if (len < nLen) return false;
  const end = start + len - nLen;
  for (let i = start; i <= end; i++) {
    let match = true;
    for (let j = 0; j < nLen; j++) {
      let b = haystack[i + j];
      if (b >= 65 && b <= 90) b += 32;
      if (b !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

interface CompactTerm {
  idf: number;
  postingsStart: number;
  postingsCount: number;
}

interface CompactIndexData {
  magic: string;
  version: number;
  gitSha: string;
  owner: string;
  repo: string;
  chunkCount: number;
  termCount: number;
  avgDocLen: number;
  stringPool: Uint8Array;
  chunkOffsets: Uint32Array; // 7 uint32s per chunk: idOff, pathOff, titleOff, headingOff, hPathOff, snipOff, tokenCount
  chunkLens: Uint16Array;    // 6 uint16s per chunk: idLen, pathLen, titleLen, headingLen, hPathLen, snipLen
  postingsChunkIndices: Uint32Array;
  postingsFreqs: Uint16Array;
  terms: Map<string, CompactTerm>;
  termList: string[];
}

function parseCompactIndex(data: Buffer | ArrayBuffer | Uint8Array): CompactIndexData {
  let buf: Buffer;
  if (Buffer.isBuffer(data)) {
    buf = data;
  } else if (data instanceof ArrayBuffer) {
    buf = Buffer.from(data);
  } else {
    buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  // Auto-detect Gzip compression (magic bytes 0x1f 0x8b)
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf);
    } catch (e) {
      throw new Error(`Invalid search index: gzip decompress failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (buf.length < 50) {
    throw new Error(`Invalid search index: data too short (${buf.length} bytes)`);
  }

  let offset = 0;
  const magic = buf.toString('ascii', offset, offset + 4);
  offset += 4;
  if (magic !== 'OGIS') {
    throw new Error(`Invalid search index magic header: expected 'OGIS', got '${magic}'`);
  }

  const version = buf.readUInt16LE(offset);
  offset += 2;
  if (version !== 1) {
    throw new Error(`Unsupported OGIS version: ${version}`);
  }

  // Flags (2B)
  offset += 2;

  // GitSha (40B fixed)
  const gitSha = buf.toString('utf-8', offset, offset + 40).trim();
  offset += 40;

  // Owner
  if (offset + 2 > buf.length) throw new Error('Invalid search index: truncated at owner length');
  const ownerLen = buf.readUInt16LE(offset);
  offset += 2;
  if (offset + ownerLen > buf.length) throw new Error('Invalid search index: truncated at owner string');
  const owner = buf.toString('utf-8', offset, offset + ownerLen);
  offset += ownerLen;

  // Repo
  if (offset + 2 > buf.length) throw new Error('Invalid search index: truncated at repo length');
  const repoLen = buf.readUInt16LE(offset);
  offset += 2;
  if (offset + repoLen > buf.length) throw new Error('Invalid search index: truncated at repo string');
  const repo = buf.toString('utf-8', offset, offset + repoLen);
  offset += repoLen;

  // Counts & AvgDocLen
  if (offset + 12 > buf.length) throw new Error('Invalid search index: truncated at counts header');
  const chunkCount = buf.readUInt32LE(offset);
  offset += 4;
  const termCount = buf.readUInt32LE(offset);
  offset += 4;
  const avgDocLen = buf.readFloatLE(offset);
  offset += 4;

  // String Pool
  if (offset + 4 > buf.length) throw new Error('Invalid search index: truncated at string pool size');
  const stringPoolSize = buf.readUInt32LE(offset);
  offset += 4;
  if (offset + stringPoolSize > buf.length) {
    throw new Error(`Invalid search index: truncated at string pool content: poolSize=${stringPoolSize}, remaining=${buf.length - offset}`);
  }
  const stringPool = new Uint8Array(buf.buffer, buf.byteOffset + offset, stringPoolSize);
  offset += stringPoolSize;

  // Chunks Table: each chunk is 40B
  const chunksTableSize = chunkCount * 40;
  if (offset + chunksTableSize > buf.length) {
    throw new Error(`Invalid search index: truncated at chunks table: expected ${chunksTableSize} bytes, remaining=${buf.length - offset}`);
  }
  const chunkOffsets = new Uint32Array(chunkCount * 7);
  const chunkLens = new Uint16Array(chunkCount * 6);

  for (let i = 0; i < chunkCount; i++) {
    const oBase = i * 7;
    const lBase = i * 6;

    // id
    chunkOffsets[oBase] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase] = buf.readUInt16LE(offset);
    offset += 2;

    // path
    chunkOffsets[oBase + 1] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 1] = buf.readUInt16LE(offset);
    offset += 2;

    // title
    chunkOffsets[oBase + 2] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 2] = buf.readUInt16LE(offset);
    offset += 2;

    // heading
    chunkOffsets[oBase + 3] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 3] = buf.readUInt16LE(offset);
    offset += 2;

    // hPath
    chunkOffsets[oBase + 4] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 4] = buf.readUInt16LE(offset);
    offset += 2;

    // snippet
    chunkOffsets[oBase + 5] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 5] = buf.readUInt16LE(offset);
    offset += 2;

    // tokenCount
    chunkOffsets[oBase + 6] = buf.readUInt32LE(offset);
    offset += 4;
  }

  // Pre-scan total postings to size single contiguous arrays
  let scanOffset = offset;
  let totalPostings = 0;
  for (let i = 0; i < termCount; i++) {
    if (scanOffset + 14 > buf.length) {
      throw new Error(`Invalid search index: truncated at term[${i}] header`);
    }
    scanOffset += 10; // termRef(6B) + idf(4B)
    const count = buf.readUInt32LE(scanOffset);
    scanOffset += 4;
    totalPostings += count;
    const postingsBytesLen = count * 6;
    if (scanOffset + postingsBytesLen > buf.length) {
      throw new Error(`Invalid search index: truncated at term[${i}] postings: expected ${postingsBytesLen} bytes, remaining=${buf.length - scanOffset}`);
    }
    scanOffset += postingsBytesLen;
  }

  const postingsChunkIndices = new Uint32Array(totalPostings);
  const postingsFreqs = new Uint16Array(totalPostings);

  const utf8Decoder = new TextDecoder('utf-8');
  const terms = new Map<string, CompactTerm>();
  const termList: string[] = [];

  let currentPostingIndex = 0;
  for (let i = 0; i < termCount; i++) {
    const termOff = buf.readUInt32LE(offset);
    offset += 4;
    const termLen = buf.readUInt16LE(offset);
    offset += 2;

    const idf = buf.readFloatLE(offset);
    offset += 4;

    const count = buf.readUInt32LE(offset);
    offset += 4;

    const postingsStart = currentPostingIndex;
    for (let p = 0; p < count; p++) {
      postingsChunkIndices[currentPostingIndex] = buf.readUInt32LE(offset);
      offset += 4;
      postingsFreqs[currentPostingIndex] = buf.readUInt16LE(offset);
      offset += 2;
      currentPostingIndex++;
    }

    const term = utf8Decoder.decode(stringPool.subarray(termOff, termOff + termLen));
    if (!terms.has(term)) {
      termList.push(term);
    }
    terms.set(term, { idf, postingsStart, postingsCount: count });
  }

  if (offset !== buf.length) {
    throw new Error(`Invalid search index: ${buf.length - offset} trailing unread bytes`);
  }

  return {
    magic,
    version,
    gitSha,
    owner,
    repo,
    chunkCount,
    termCount,
    avgDocLen,
    stringPool,
    chunkOffsets,
    chunkLens,
    postingsChunkIndices,
    postingsFreqs,
    terms,
    termList,
  };
}

export class BinarySearchEngine {
  private compact: CompactIndexData | null = null;
  private snapshot: SearchIndexSnapshot | null = null;
  private termList: string[];
  private utf8Decoder = new TextDecoder('utf-8');
  private utf8Encoder = new TextEncoder();

  constructor(source: SearchIndexSnapshot | Buffer | ArrayBuffer | Uint8Array) {
    if (source instanceof ArrayBuffer || source instanceof Uint8Array || Buffer.isBuffer(source)) {
      // High-performance compact TypedArray representation
      this.compact = parseCompactIndex(source);
      this.termList = this.compact.termList;
    } else {
      // Legacy snapshot compatibility
      this.snapshot = source;
      this.termList = Array.from(source.terms.keys());
    }
  }

  get gitSha(): string {
    return this.compact ? this.compact.gitSha : this.snapshot!.gitSha;
  }

  get chunkCount(): number {
    return this.compact ? this.compact.chunkCount : this.snapshot!.chunks.length;
  }

  get termCount(): number {
    return this.compact ? this.compact.termCount : this.snapshot!.terms.size;
  }

  get owner(): string {
    return this.compact ? this.compact.owner : this.snapshot!.owner;
  }

  get repo(): string {
    return this.compact ? this.compact.repo : this.snapshot!.repo;
  }

  get avgDocLen(): number {
    return this.compact ? this.compact.avgDocLen : this.snapshot!.avgDocLen;
  }

  /**
   * Performs an instant in-memory BM25 query.
   * Execution time typically < 1ms with zero unnecessary string allocations.
   */
  search(query: string, limit = 20): SearchResultItem[] {
    const rawTokens = tokenizeSearchText(query);
    if (rawTokens.length === 0) return [];

    const k1 = 1.2;
    const b = 0.75;
    const avgdl = this.avgDocLen || 1;

    // chunkIndex -> accumulated score
    const scores = new Map<number, number>();

    for (const token of rawTokens) {
      // 1. Exact match lookup
      this.lookupAndScore(token, 1.0, k1, b, avgdl, scores);

      // 2. Prefix match expansion (search-as-you-type)
      if (token.length >= 2) {
        let prefixMatches = 0;
        for (const candidate of this.termList) {
          if (candidate !== token && candidate.startsWith(token)) {
            this.lookupAndScore(candidate, 0.7, k1, b, avgdl, scores);
            prefixMatches++;
            if (prefixMatches >= 8) break; // SLA bound
          }
        }
      }
    }

    if (scores.size === 0) return [];

    // Rank candidate chunks by score descending with deterministic tie-breaking
    const rankedIndices = Array.from(scores.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] - b[0];
      })
      .slice(0, limit);

    const owner = this.owner;
    const repo = this.repo;

    // Only decode UTF-8 strings for the Top-K results
    return rankedIndices.map(([chunkIndex, score]) => {
      const { id, docPath, title, heading, snippet } = this.getChunkStrings(chunkIndex);

      const fullTitle = heading ? (title ? `${title} › ${heading}` : heading) : (title || heading);
      const hashFragment = heading ? `#${slugify(heading)}` : '';
      const cleanDocPath = docPath.replace(/^\//, '').replace(/\.(md|mdx)$/, '');
      const url = `/docs/${owner}/${repo}/${cleanDocPath}${hashFragment}`;

      return {
        id,
        type: 'document' as const,
        title: fullTitle,
        description: snippet,
        url,
        owner,
        repo,
        score: Math.round(score * 100) / 100,
      };
    });
  }

  private lookupAndScore(
    term: string,
    weightMultiplier: number,
    k1: number,
    b: number,
    avgdl: number,
    scores: Map<number, number>,
  ): void {
    if (this.compact) {
      const termEntry = this.compact.terms.get(term);
      if (!termEntry) return;

      const idf = termEntry.idf;
      const start = termEntry.postingsStart;
      const count = termEntry.postingsCount;
      const chunkIndices = this.compact.postingsChunkIndices;
      const freqs = this.compact.postingsFreqs;
      const chunkOffsets = this.compact.chunkOffsets;
      const termBytes = this.utf8Encoder.encode(term.toLowerCase());

      for (let p = 0; p < count; p++) {
        const idx = start + p;
        const chunkIndex = chunkIndices[idx];
        const f = freqs[idx];
        const docLen = chunkOffsets[chunkIndex * 7 + 6] || 1;

        // Standard BM25 term frequency saturation
        const tf = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen / avgdl)));
        let termScore = idf * tf * weightMultiplier;

        // Title or heading semantic boost
        if (this.compactChunkMatchesTermBytes(chunkIndex, termBytes)) {
          termScore *= 1.2;
        }

        scores.set(chunkIndex, (scores.get(chunkIndex) || 0) + termScore);
      }
    } else {
      const exactTerm = this.snapshot!.terms.get(term);
      if (!exactTerm) return;

      const idf = exactTerm.idf;
      for (const posting of exactTerm.postings) {
        const chunkIndex = posting.chunkIndex;
        const chunk = this.snapshot!.chunks[chunkIndex];
        if (!chunk) continue;

        const f = posting.freq;
        const docLen = chunk.tokenCount || 1;

        const tf = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen / avgdl)));
        let termScore = idf * tf * weightMultiplier;

        if (
          chunk.title.toLowerCase().includes(term.toLowerCase()) ||
          chunk.heading.toLowerCase().includes(term.toLowerCase())
        ) {
          termScore *= 1.2;
        }

        scores.set(chunkIndex, (scores.get(chunkIndex) || 0) + termScore);
      }
    }
  }

  private compactChunkMatchesTermBytes(chunkIndex: number, termBytes: Uint8Array): boolean {
    if (!this.compact || termBytes.length === 0) return false;

    // Check title (zero-allocation byte scanning)
    const titleOff = this.compact.chunkOffsets[chunkIndex * 7 + 2];
    const titleLen = this.compact.chunkLens[chunkIndex * 6 + 2];
    if (titleLen > 0 && bytesContainsFold(this.compact.stringPool, titleOff, titleLen, termBytes)) {
      return true;
    }

    // Check heading (zero-allocation byte scanning)
    const headingOff = this.compact.chunkOffsets[chunkIndex * 7 + 3];
    const headingLen = this.compact.chunkLens[chunkIndex * 6 + 3];
    if (headingLen > 0 && bytesContainsFold(this.compact.stringPool, headingOff, headingLen, termBytes)) {
      return true;
    }

    return false;
  }

  private decodePoolSlice(offset: number, length: number): string {
    if (length === 0 || !this.compact) return '';
    return this.utf8Decoder.decode(this.compact.stringPool.subarray(offset, offset + length));
  }

  private getChunkStrings(chunkIndex: number): {
    id: string;
    docPath: string;
    title: string;
    heading: string;
    snippet: string;
  } {
    if (this.compact) {
      const oBase = chunkIndex * 7;
      const lBase = chunkIndex * 6;
      return {
        id: this.decodePoolSlice(this.compact.chunkOffsets[oBase], this.compact.chunkLens[lBase]),
        docPath: this.decodePoolSlice(this.compact.chunkOffsets[oBase + 1], this.compact.chunkLens[lBase + 1]),
        title: this.decodePoolSlice(this.compact.chunkOffsets[oBase + 2], this.compact.chunkLens[lBase + 2]),
        heading: this.decodePoolSlice(this.compact.chunkOffsets[oBase + 3], this.compact.chunkLens[lBase + 3]),
        snippet: this.decodePoolSlice(this.compact.chunkOffsets[oBase + 5], this.compact.chunkLens[lBase + 5]),
      };
    } else {
      const chunk: UnpackedChunkRecord = this.snapshot!.chunks[chunkIndex];
      return {
        id: chunk.id,
        docPath: chunk.docPath,
        title: chunk.title,
        heading: chunk.heading,
        snippet: chunk.snippet,
      };
    }
  }
}

// Module-level LRU cache for instantiated engines (capped at 4 repos to protect V8 heap)
const MAX_CACHED_ENGINES = 4;
const engineCache = new Map<string, BinarySearchEngine>();
const engineLoadingPromises = new Map<string, Promise<BinarySearchEngine | null>>();

function touchEngine(key: string, engine: BinarySearchEngine) {
  engineCache.delete(key);
  engineCache.set(key, engine);
  while (engineCache.size > MAX_CACHED_ENGINES) {
    const oldestKey = engineCache.keys().next().value;
    if (oldestKey) {
      engineCache.delete(oldestKey);
    } else {
      break;
    }
  }
}

/**
 * Loads or returns a cached BinarySearchEngine for the specified repository.
 */
export async function getOrLoadSearchEngine(
  owner: string,
  repo: string,
  customFetch?: (url: string) => Promise<ArrayBuffer>,
): Promise<BinarySearchEngine | null> {
  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;

  const cached = engineCache.get(cacheKey);
  if (cached) {
    touchEngine(cacheKey, cached);
    return cached;
  }

  const inFlight = engineLoadingPromises.get(cacheKey);
  if (inFlight) return inFlight;

  const loadPromise = (async () => {
    try {
      const url = `/api/search/index/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      let arrayBuffer: ArrayBuffer;

      if (customFetch) {
        arrayBuffer = await customFetch(url);
      } else {
        const res = await fetch(url, {
          headers: { Accept: 'application/octet-stream' },
        });
        if (!res.ok) {
          return null;
        }
        arrayBuffer = await res.arrayBuffer();
      }

      // Instantiate directly from arrayBuffer using compact TypedArray representation (Zero-Heap Storm)
      const engine = new BinarySearchEngine(arrayBuffer);
      touchEngine(cacheKey, engine);
      return engine;
    } catch {
      return null;
    } finally {
      engineLoadingPromises.delete(cacheKey);
    }
  })();

  engineLoadingPromises.set(cacheKey, loadPromise);
  return loadPromise;
}

/**
 * Clears the local in-memory engine cache (useful for testing or cache eviction).
 */
export function clearSearchEngineCache(): void {
  engineCache.clear();
  engineLoadingPromises.clear();
}
