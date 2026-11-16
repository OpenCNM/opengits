/**
 * apps/client/src/lib/search/binary-index-packer.ts
 *
 * OpenGits Index Stream (OGIS v1) Binary Packer & Unpacker.
 *
 * Binary Layout:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Magic (4B: 'OGIS') | Version (2B: 1) | Flags (2B)           │
 * ├─────────────────────────────────────────────────────────────┤
 * │ Header: gitSha (40B) | ownerLen/str | repoLen/str           │
 * │ chunkCount (4B) | termCount (4B) | avgDocLen (4B float)     │
 * ├─────────────────────────────────────────────────────────────┤
 * │ String Pool: TotalSize (4B) | UTF-8 String Bytes            │
 * ├─────────────────────────────────────────────────────────────┤
 * │ Chunks Table: [idOff, idLen, pathOff, pathLen,              │
 * │                titleOff, titleLen, headingOff, headingLen,  │
 * │                hPathOff, hPathLen, snipOff, snipLen, len]   │
 * ├─────────────────────────────────────────────────────────────┤
 * │ Postings Table: [termOff, termLen, idf (4B float), count]   │
 * │   -> for each posting: [chunkIndex (4B), freq (2B)]         │
 * └─────────────────────────────────────────────────────────────┘
 */

import zlib from 'node:zlib';

export const OGIS_MAGIC = 'OGIS';
export const OGIS_VERSION = 1;

export interface RawChunkRecord {
  id: string;
  docPath: string;
  title: string;
  heading: string | null;
  headingPath: string | null;
  content: string;
  tokens: string[];
}

export interface IndexPackInput {
  owner: string;
  repo: string;
  gitSha: string;
  chunks: RawChunkRecord[];
}

export interface UnpackedChunkRecord {
  id: string;
  docPath: string;
  title: string;
  heading: string;
  headingPath: string;
  snippet: string;
  tokenCount: number;
}

export interface UnpackedPosting {
  chunkIndex: number;
  freq: number;
}

export interface UnpackedTermEntry {
  term: string;
  idf: number;
  postings: UnpackedPosting[];
}

export interface SearchIndexSnapshot {
  magic: string;
  version: number;
  owner: string;
  repo: string;
  gitSha: string;
  avgDocLen: number;
  chunks: UnpackedChunkRecord[];
  terms: Map<string, UnpackedTermEntry>;
}

/**
 * Packs repository search chunks into an OGIS v1 binary buffer, compressed with Gzip.
 * gzipLevel 默认 1：索引是可重建的派生数据，压缩速度优先于压缩率（事件循环阻塞时长随级别陡增）。
 */
export function packSearchIndex(input: IndexPackInput, compress = true, gzipLevel = 1): Buffer {
  const { owner, repo, gitSha, chunks } = input;

  // 1. Build string pool (dictionary deduplication)
  const stringPoolMap = new Map<string, { offset: number; len: number }>();
  const stringBufferList: Buffer[] = [];
  let currentStringOffset = 0;

  function internString(str: string | null | undefined): { offset: number; len: number } {
    const val = str ?? '';
    const cached = stringPoolMap.get(val);
    if (cached) return cached;

    const buf = Buffer.from(val, 'utf-8');
    const entry = { offset: currentStringOffset, len: buf.length };
    stringPoolMap.set(val, entry);
    stringBufferList.push(buf);
    currentStringOffset += buf.length;
    return entry;
  }

  // Pre-intern common and empty strings
  internString('');

  // 2. Process chunks and calculate inverted index & BM25 IDF
  const N = chunks.length;
  let totalTokenCount = 0;

  // term -> Map<chunkIndex, freq>
  const termPostings = new Map<string, Map<number, number>>();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tokens = chunk.tokens;
    totalTokenCount += tokens.length;

    for (const token of tokens) {
      let postings = termPostings.get(token);
      if (!postings) {
        postings = new Map<number, number>();
        termPostings.set(token, postings);
      }
      postings.set(i, (postings.get(i) || 0) + 1);
    }
  }

  const avgDocLen = N > 0 ? totalTokenCount / N : 0;

  // Intern chunk strings
  interface ChunkEntryMetadata {
    idRef: { offset: number; len: number };
    pathRef: { offset: number; len: number };
    titleRef: { offset: number; len: number };
    headingRef: { offset: number; len: number };
    hPathRef: { offset: number; len: number };
    snippetRef: { offset: number; len: number };
    tokenCount: number;
  }

  const chunkEntries: ChunkEntryMetadata[] = chunks.map((c) => {
    // Generate clean snippet (first 160 chars)
    const snippet = c.content.replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      idRef: internString(c.id),
      pathRef: internString(c.docPath),
      titleRef: internString(c.title),
      headingRef: internString(c.heading),
      hPathRef: internString(c.headingPath),
      snippetRef: internString(snippet),
      tokenCount: c.tokens.length,
    };
  });

  // Intern term strings and compute BM25 IDF
  interface TermPackEntry {
    termRef: { offset: number; len: number };
    idf: number;
    postings: { chunkIndex: number; freq: number }[];
  }

  const termEntries: TermPackEntry[] = [];
  for (const [term, postingsMap] of termPostings.entries()) {
    const n = postingsMap.size;
    // Standard BM25 IDF formula with smoothing
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const postings: { chunkIndex: number; freq: number }[] = [];
    for (const [chunkIndex, freq] of postingsMap.entries()) {
      postings.push({ chunkIndex, freq: Math.min(freq, 65535) });
    }
    // Sort postings by chunkIndex for deterministic layout
    postings.sort((a, b) => a.chunkIndex - b.chunkIndex);

    termEntries.push({
      termRef: internString(term),
      idf,
      postings,
    });
  }

  // 3. Assemble binary stream
  const fullStringPool = Buffer.concat(stringBufferList);

  // Calculate required byte sizes
  // Header:
  // - Magic (4) + Version (2) + Flags (2) = 8
  // - GitSha (40 bytes fixed) = 40
  // - Owner len (2) + Owner str
  // - Repo len (2) + Repo str
  // - ChunkCount (4) + TermCount (4) + AvgDocLen (4) = 12
  const ownerBuf = Buffer.from(owner, 'utf-8');
  const repoBuf = Buffer.from(repo, 'utf-8');
  const gitShaPadded = Buffer.alloc(40, 0x20); // space-padded 40B
  Buffer.from(gitSha.slice(0, 40), 'utf-8').copy(gitShaPadded);

  const headerFixedSize = 8 + 40 + (2 + ownerBuf.length) + (2 + repoBuf.length) + 12;

  // String Pool segment:
  // - Size (4) + pool bytes
  const stringPoolSegmentSize = 4 + fullStringPool.length;

  // Chunks table:
  // Each chunk: 6 string refs (each offset: uint32, len: uint16 = 6B) + tokenCount (4B) = 6 * 6 + 4 = 40B
  const chunksTableSize = chunks.length * 40;

  // Postings table:
  // Each term: termRef (6B) + idf (4B float) + count (4B) = 14B
  // Each posting: chunkIndex (4B) + freq (2B) = 6B
  let postingsTableSize = 0;
  for (const t of termEntries) {
    postingsTableSize += 14 + t.postings.length * 6;
  }

  const totalRawSize = headerFixedSize + stringPoolSegmentSize + chunksTableSize + postingsTableSize;
  const rawBuffer = Buffer.alloc(totalRawSize);
  let offset = 0;

  // Write Magic, Version, Flags
  rawBuffer.write(OGIS_MAGIC, offset, 4, 'ascii');
  offset += 4;
  rawBuffer.writeUInt16LE(OGIS_VERSION, offset);
  offset += 2;
  rawBuffer.writeUInt16LE(compress ? 1 : 0, offset); // Flags
  offset += 2;

  // Write GitSha
  gitShaPadded.copy(rawBuffer, offset);
  offset += 40;

  // Write Owner
  rawBuffer.writeUInt16LE(ownerBuf.length, offset);
  offset += 2;
  ownerBuf.copy(rawBuffer, offset);
  offset += ownerBuf.length;

  // Write Repo
  rawBuffer.writeUInt16LE(repoBuf.length, offset);
  offset += 2;
  repoBuf.copy(rawBuffer, offset);
  offset += repoBuf.length;

  // Write Counts & AvgDocLen
  rawBuffer.writeUInt32LE(chunks.length, offset);
  offset += 4;
  rawBuffer.writeUInt32LE(termEntries.length, offset);
  offset += 4;
  rawBuffer.writeFloatLE(avgDocLen, offset);
  offset += 4;

  // Write String Pool
  rawBuffer.writeUInt32LE(fullStringPool.length, offset);
  offset += 4;
  fullStringPool.copy(rawBuffer, offset);
  offset += fullStringPool.length;

  // Write Chunks Table
  for (const c of chunkEntries) {
    rawBuffer.writeUInt32LE(c.idRef.offset, offset);
    offset += 4;
    rawBuffer.writeUInt16LE(c.idRef.len, offset);
    offset += 2;

    rawBuffer.writeUInt32LE(c.pathRef.offset, offset);
    offset += 4;
    rawBuffer.writeUInt16LE(c.pathRef.len, offset);
    offset += 2;

    rawBuffer.writeUInt32LE(c.titleRef.offset, offset);
    offset += 4;
    rawBuffer.writeUInt16LE(c.titleRef.len, offset);
    offset += 2;

    rawBuffer.writeUInt32LE(c.headingRef.offset, offset);
    offset += 4;
    rawBuffer.writeUInt16LE(c.headingRef.len, offset);
    offset += 2;

    rawBuffer.writeUInt32LE(c.hPathRef.offset, offset);
    offset += 4;
    rawBuffer.writeUInt16LE(c.hPathRef.len, offset);
    offset += 2;

    rawBuffer.writeUInt32LE(c.snippetRef.offset, offset);
    offset += 4;
    rawBuffer.writeUInt16LE(c.snippetRef.len, offset);
    offset += 2;

    rawBuffer.writeUInt32LE(c.tokenCount, offset);
    offset += 4;
  }

  // Write Postings Table
  for (const t of termEntries) {
    rawBuffer.writeUInt32LE(t.termRef.offset, offset);
    offset += 4;
    rawBuffer.writeUInt16LE(t.termRef.len, offset);
    offset += 2;

    rawBuffer.writeFloatLE(t.idf, offset);
    offset += 4;

    rawBuffer.writeUInt32LE(t.postings.length, offset);
    offset += 4;

    for (const p of t.postings) {
      rawBuffer.writeUInt32LE(p.chunkIndex, offset);
      offset += 4;
      rawBuffer.writeUInt16LE(p.freq, offset);
      offset += 2;
    }
  }

  if (compress) {
    return zlib.gzipSync(rawBuffer, { level: gzipLevel });
  }

  return rawBuffer;
}

/**
 * Unpacks an OGIS v1 binary buffer (either compressed or raw) into an in-memory SearchIndexSnapshot.
 */
export function unpackSearchIndex(data: Buffer | ArrayBuffer | Uint8Array): SearchIndexSnapshot {
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
    buf = zlib.gunzipSync(buf);
  }

  if (!buf || buf.length < 48) {
    throw new Error(`Invalid search index buffer: expected at least 48 bytes, got ${buf?.length ?? 0}`);
  }

  let offset = 0;

  // 1. Read & Validate Magic
  const magic = buf.toString('ascii', offset, offset + 4);
  offset += 4;
  if (magic !== OGIS_MAGIC) {
    throw new Error(`Invalid search index magic header: expected '${OGIS_MAGIC}', got '${magic}'`);
  }

  const version = buf.readUInt16LE(offset);
  offset += 2;
  if (version !== OGIS_VERSION) {
    throw new Error(`Unsupported OGIS version: ${version}`);
  }

  // Flags
  offset += 2;

  // GitSha (40B fixed)
  const gitSha = buf.toString('utf-8', offset, offset + 40).trim();
  offset += 40;

  // Owner
  if (offset + 2 > buf.length) {
    throw new Error('Truncated search index buffer while reading owner length');
  }
  const ownerLen = buf.readUInt16LE(offset);
  offset += 2;
  if (offset + ownerLen + 2 > buf.length) {
    throw new Error('Truncated search index buffer while reading owner and repo length');
  }
  const owner = buf.toString('utf-8', offset, offset + ownerLen);
  offset += ownerLen;

  // Repo
  const repoLen = buf.readUInt16LE(offset);
  offset += 2;
  if (offset + repoLen + 12 > buf.length) {
    throw new Error('Truncated search index buffer while reading repo and counts');
  }
  const repo = buf.toString('utf-8', offset, offset + repoLen);
  offset += repoLen;

  // Counts & AvgDocLen
  const chunkCount = buf.readUInt32LE(offset);
  offset += 4;
  const termCount = buf.readUInt32LE(offset);
  offset += 4;
  const avgDocLen = buf.readFloatLE(offset);
  offset += 4;

  // 2. Read String Pool
  if (offset + 4 > buf.length) {
    throw new Error('Truncated search index buffer while reading string pool size');
  }
  const stringPoolSize = buf.readUInt32LE(offset);
  offset += 4;
  if (offset + stringPoolSize > buf.length) {
    throw new Error('Truncated search index buffer while reading string pool data');
  }
  const stringPoolSlice = buf.subarray(offset, offset + stringPoolSize);
  offset += stringPoolSize;

  function readPooledString(strOffset: number, strLen: number): string {
    if (strLen === 0) return '';
    return stringPoolSlice.toString('utf-8', strOffset, strOffset + strLen);
  }

  // 3. Read Chunks Table
  if (offset + chunkCount * 40 > buf.length) {
    throw new Error('Truncated search index buffer while reading chunks table');
  }
  const chunks: UnpackedChunkRecord[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const idOff = buf.readUInt32LE(offset);
    offset += 4;
    const idLen = buf.readUInt16LE(offset);
    offset += 2;

    const pathOff = buf.readUInt32LE(offset);
    offset += 4;
    const pathLen = buf.readUInt16LE(offset);
    offset += 2;

    const titleOff = buf.readUInt32LE(offset);
    offset += 4;
    const titleLen = buf.readUInt16LE(offset);
    offset += 2;

    const headingOff = buf.readUInt32LE(offset);
    offset += 4;
    const headingLen = buf.readUInt16LE(offset);
    offset += 2;

    const hPathOff = buf.readUInt32LE(offset);
    offset += 4;
    const hPathLen = buf.readUInt16LE(offset);
    offset += 2;

    const snipOff = buf.readUInt32LE(offset);
    offset += 4;
    const snipLen = buf.readUInt16LE(offset);
    offset += 2;

    const tokenCount = buf.readUInt32LE(offset);
    offset += 4;

    chunks.push({
      id: readPooledString(idOff, idLen),
      docPath: readPooledString(pathOff, pathLen),
      title: readPooledString(titleOff, titleLen),
      heading: readPooledString(headingOff, headingLen),
      headingPath: readPooledString(hPathOff, hPathLen),
      snippet: readPooledString(snipOff, snipLen),
      tokenCount,
    });
  }

  // 4. Read Postings Table
  const terms = new Map<string, UnpackedTermEntry>();
  for (let i = 0; i < termCount; i++) {
    if (offset + 14 > buf.length) {
      throw new Error('Truncated search index buffer while reading term entry');
    }
    const termOff = buf.readUInt32LE(offset);
    offset += 4;
    const termLen = buf.readUInt16LE(offset);
    offset += 2;

    const idf = buf.readFloatLE(offset);
    offset += 4;

    const postingsCount = buf.readUInt32LE(offset);
    offset += 4;

    if (offset + postingsCount * 6 > buf.length) {
      throw new Error('Truncated search index buffer while reading postings');
    }
    const postings: UnpackedPosting[] = [];
    for (let p = 0; p < postingsCount; p++) {
      const chunkIndex = buf.readUInt32LE(offset);
      offset += 4;
      const freq = buf.readUInt16LE(offset);
      offset += 2;
      postings.push({ chunkIndex, freq });
    }

    const term = readPooledString(termOff, termLen);
    terms.set(term, { term, idf, postings });
  }

  return {
    magic,
    version,
    owner,
    repo,
    gitSha,
    avgDocLen,
    chunks,
    terms,
  };
}
