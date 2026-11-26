import zlib from 'node:zlib';
import type { SearchResultItem } from '@/app/api/search/route';
import {
  unpackSearchIndex,
  type SearchIndexSnapshot,
  type UnpackedChunkRecord,
} from '@/lib/search/binary-index-packer';
import { tokenizeSearchText } from '@/lib/search/binary-index-tokenizer';
import { fnv1a64Hex } from '@/lib/fnv64a';

export function slugify(text: string): string {
  const trimmed = text.trim();
  const slug = trimmed
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\u3040-\u30ff\u30fc\u3005\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // FNV-1a 64-bit fallback prevents empty slugs on non-ASCII headings (synced with Go mdpat.Slugify).
  if (slug === '' && trimmed !== '') return `h-${fnv1a64Hex(trimmed)}`;
  return slug;
}

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
  chunkOffsets: Uint32Array;
  chunkLens: Uint16Array;
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

  offset += 2;

  const gitSha = buf.toString('utf-8', offset, offset + 40).trim();
  offset += 40;

  if (offset + 2 > buf.length) throw new Error('Invalid search index: truncated at owner length');
  const ownerLen = buf.readUInt16LE(offset);
  offset += 2;
  if (offset + ownerLen > buf.length) throw new Error('Invalid search index: truncated at owner string');
  const owner = buf.toString('utf-8', offset, offset + ownerLen);
  offset += ownerLen;

  if (offset + 2 > buf.length) throw new Error('Invalid search index: truncated at repo length');
  const repoLen = buf.readUInt16LE(offset);
  offset += 2;
  if (offset + repoLen > buf.length) throw new Error('Invalid search index: truncated at repo string');
  const repo = buf.toString('utf-8', offset, offset + repoLen);
  offset += repoLen;

  if (offset + 12 > buf.length) throw new Error('Invalid search index: truncated at counts header');
  const chunkCount = buf.readUInt32LE(offset);
  offset += 4;
  const termCount = buf.readUInt32LE(offset);
  offset += 4;
  const avgDocLen = buf.readFloatLE(offset);
  offset += 4;

  if (offset + 4 > buf.length) throw new Error('Invalid search index: truncated at string pool size');
  const stringPoolSize = buf.readUInt32LE(offset);
  offset += 4;
  if (offset + stringPoolSize > buf.length) {
    throw new Error(`Invalid search index: truncated at string pool content: poolSize=${stringPoolSize}, remaining=${buf.length - offset}`);
  }
  const stringPool = new Uint8Array(buf.buffer, buf.byteOffset + offset, stringPoolSize);
  offset += stringPoolSize;

  const chunksTableSize = chunkCount * 40;
  if (offset + chunksTableSize > buf.length) {
    throw new Error(`Invalid search index: truncated at chunks table: expected ${chunksTableSize} bytes, remaining=${buf.length - offset}`);
  }
  const chunkOffsets = new Uint32Array(chunkCount * 7);
  const chunkLens = new Uint16Array(chunkCount * 6);

  for (let i = 0; i < chunkCount; i++) {
    const oBase = i * 7;
    const lBase = i * 6;

    chunkOffsets[oBase] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase] = buf.readUInt16LE(offset);
    offset += 2;

    chunkOffsets[oBase + 1] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 1] = buf.readUInt16LE(offset);
    offset += 2;

    chunkOffsets[oBase + 2] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 2] = buf.readUInt16LE(offset);
    offset += 2;

    chunkOffsets[oBase + 3] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 3] = buf.readUInt16LE(offset);
    offset += 2;

    chunkOffsets[oBase + 4] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 4] = buf.readUInt16LE(offset);
    offset += 2;

    chunkOffsets[oBase + 5] = buf.readUInt32LE(offset);
    offset += 4;
    chunkLens[lBase + 5] = buf.readUInt16LE(offset);
    offset += 2;

    chunkOffsets[oBase + 6] = buf.readUInt32LE(offset);
    offset += 4;
  }

  let scanOffset = offset;
  let totalPostings = 0;
  for (let i = 0; i < termCount; i++) {
    if (scanOffset + 14 > buf.length) {
      throw new Error(`Invalid search index: truncated at term[${i}] header`);
    }
    scanOffset += 10;
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
      this.compact = parseCompactIndex(source);
      this.termList = this.compact.termList;
    } else {
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

  search(query: string, limit = 20): SearchResultItem[] {
    const rawTokens = tokenizeSearchText(query);
    if (rawTokens.length === 0) return [];

    const k1 = 1.2;
    const b = 0.75;
    const avgdl = this.avgDocLen || 1;

    const scores = new Map<number, number>();

    for (const token of rawTokens) {
      this.lookupAndScore(token, 1.0, k1, b, avgdl, scores);

      if (token.length >= 2) {
        let prefixMatches = 0;
        for (const candidate of this.termList) {
          if (candidate !== token && candidate.startsWith(token)) {
            this.lookupAndScore(candidate, 0.7, k1, b, avgdl, scores);
            prefixMatches++;
            if (prefixMatches >= 8) break; // Cap prefix expansions per term at 8 to bound latency.
          }
        }
      }
    }

    if (scores.size === 0) return [];

    const rankedIndices = Array.from(scores.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] - b[0];
      })
      .slice(0, limit);

    const owner = this.owner;
    const repo = this.repo;

    // Decode UTF-8 strings only for Top-K results.
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

        const tf = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen / avgdl)));
        let termScore = idf * tf * weightMultiplier;

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

    const titleOff = this.compact.chunkOffsets[chunkIndex * 7 + 2];
    const titleLen = this.compact.chunkLens[chunkIndex * 6 + 2];
    if (titleLen > 0 && bytesContainsFold(this.compact.stringPool, titleOff, titleLen, termBytes)) {
      return true;
    }

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

// Cap instantiated engines at 4 repos to protect V8 heap.
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

export function clearSearchEngineCache(): void {
  engineCache.clear();
  engineLoadingPromises.clear();
}
