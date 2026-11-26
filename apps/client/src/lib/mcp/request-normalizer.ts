import { NextRequest, NextResponse } from 'next/server';
import { getCorsHeaders } from '@/lib/constants';
import { readBodyJson } from './body-json';
import { TOOL_ALIASES, buildUnknownToolResult } from './unknown-tool-fallback';
import { recordMcpToolError } from '@/lib/telemetry/mcp-beacon';

export interface NormalizeMcpResult {
  request: NextRequest;
  directResponse: NextResponse | null;
}

// Rewrites legacy tool aliases and rejects unknown tools before touching McpServer internals or DB queries.
export async function normalizeMcpToolCallRequest(
  request: NextRequest,
  availableTools: readonly string[],
  label: string
): Promise<NormalizeMcpResult> {
  const body = await readBodyJson(request);
  if (!body) {
    return { request, directResponse: null };
  }

  if (!body || typeof body !== 'object' || body.method !== 'tools/call') {
    return { request, directResponse: null };
  }

  const rawName = body.params?.name;
  if (!rawName || typeof rawName !== 'string') {
    return { request, directResponse: null };
  }

  const trimmedName = rawName.trim();
  const normalizedKey = trimmedName.toLowerCase();

  if (availableTools.includes(trimmedName)) {
    return { request, directResponse: null };
  }

  let canonicalName = TOOL_ALIASES[normalizedKey];
  const rawArgs = { ...(body.params?.arguments || {}) };
  const adaptedArgs: Record<string, any> = { ...rawArgs };

  if (
    normalizedKey === 'read_document' &&
    !adaptedArgs.target &&
    !adaptedArgs.path &&
    !adaptedArgs.section
  ) {
    canonicalName = 'browse';
  }

  if (normalizedKey === 'explore_concept') {
    const rawAction = typeof adaptedArgs.action === 'string' ? adaptedArgs.action.trim().toLowerCase() : '';
    if (
      rawAction === 'course_map' ||
      rawAction === 'architecture' ||
      rawAction === 'coverage' ||
      rawAction === 'recommend'
    ) {
      canonicalName = 'browse';
      adaptedArgs.view = rawAction;
      if (rawAction === 'architecture' && adaptedArgs.concept && !adaptedArgs.path) {
        adaptedArgs.path = adaptedArgs.concept;
      }
      if ((rawAction === 'coverage' || rawAction === 'recommend') && adaptedArgs.concept && !adaptedArgs.query) {
        adaptedArgs.query = adaptedArgs.concept;
      }
      delete adaptedArgs.action;
    }
  }

  if (canonicalName && availableTools.includes(canonicalName)) {
    if (canonicalName === 'browse') {
      if (
        (normalizedKey === 'list_resources' ||
          normalizedKey === 'list_repositories' ||
          normalizedKey === 'list_repos' ||
          normalizedKey === 'list_tutorials' ||
          normalizedKey === 'list_tutorial') &&
        !adaptedArgs.view &&
        !adaptedArgs.path
      ) {
        adaptedArgs.view = 'resources';
      } else if (normalizedKey === 'course_map') {
        adaptedArgs.view = 'course_map';
      } else if (normalizedKey === 'skill_coverage') {
        adaptedArgs.view = 'coverage';
        if (adaptedArgs.concept && !adaptedArgs.query) adaptedArgs.query = adaptedArgs.concept;
      } else if (normalizedKey === 'recommend_tutorial') {
        adaptedArgs.view = 'recommend';
        if (adaptedArgs.concept && !adaptedArgs.query) adaptedArgs.query = adaptedArgs.concept;
      }
    }

    if (canonicalName === 'read') {
      if (normalizedKey === 'concept_neighbors' && !adaptedArgs.action) {
        adaptedArgs.action = 'neighbors';
      } else if (normalizedKey === 'learning_path' && !adaptedArgs.action) {
        adaptedArgs.action = 'path';
      } else if (
        (normalizedKey === 'explore_concept' ||
          normalizedKey === 'concept_details' ||
          normalizedKey === 'get_concept_details') &&
        !adaptedArgs.action
      ) {
        adaptedArgs.action = 'details';
      }

      if (adaptedArgs.path && !adaptedArgs.target) {
        adaptedArgs.target = adaptedArgs.section
          ? `${adaptedArgs.path}#${adaptedArgs.section}`
          : adaptedArgs.path;
        delete adaptedArgs.path;
        delete adaptedArgs.section;
      } else if (adaptedArgs.section && !adaptedArgs.target) {
        adaptedArgs.target = adaptedArgs.section;
        delete adaptedArgs.section;
      }
    }

    if (canonicalName === 'search') {
      if (adaptedArgs.mode && !adaptedArgs.filter) {
        adaptedArgs.filter = adaptedArgs.mode;
        delete adaptedArgs.mode;
      }
      if (adaptedArgs.dimension && !adaptedArgs.filter) {
        adaptedArgs.filter = adaptedArgs.dimension === 'gotcha' ? 'gotchas' : adaptedArgs.dimension;
      }
      if (adaptedArgs.filter === 'gotcha' || adaptedArgs.filter === 'warning') {
        adaptedArgs.filter = 'gotchas';
      } else if (adaptedArgs.filter === 'symbol') {
        adaptedArgs.filter = 'symbols';
      }

      if (
        normalizedKey === 'check_breaking_changes' ||
        normalizedKey === 'breaking_changes' ||
        normalizedKey === 'breaking_change' ||
        normalizedKey === 'check_breaking_change'
      ) {
        adaptedArgs.filter = 'gotchas';
      } else if (
        normalizedKey === 'search_symbols' ||
        normalizedKey === 'find_symbols' ||
        normalizedKey === 'symbol_search' ||
        normalizedKey === 'search_symbol' ||
        normalizedKey === 'find_symbol'
      ) {
        adaptedArgs.filter = 'symbols';
      } else if (!adaptedArgs.filter) {
        if (normalizedKey === 'search_architecture') adaptedArgs.filter = 'architecture';
        else if (normalizedKey === 'search_code_examples') adaptedArgs.filter = 'code';
        else if (normalizedKey === 'concept_search') adaptedArgs.filter = 'concept';
        else if (normalizedKey === 'search_docs' || normalizedKey === 'search_doc') adaptedArgs.filter = 'docs';
      }
    }

    if (canonicalName === 'read_code') {
      if (adaptedArgs.file && !adaptedArgs.path) {
        adaptedArgs.path = adaptedArgs.file;
      }
    }

    const rewrittenBody = {
      ...body,
      params: {
        ...body.params,
        name: canonicalName,
        arguments: adaptedArgs,
      },
    };

    const rewrittenRequest = new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(rewrittenBody),
    });

    return { request: rewrittenRequest, directResponse: null };
  }

  recordMcpToolError({
    toolName: trimmedName,
    query: JSON.stringify(body.params?.arguments ?? {}).slice(0, 200),
    responseTimeMs: 0,
    errorMessage: `Tool not found: ${trimmedName}`,
  });

  const unknownResult = buildUnknownToolResult(trimmedName, [...availableTools], label);
  const responsePayload = {
    jsonrpc: '2.0',
    id: body.id ?? null,
    result: unknownResult,
  };

  return {
    request,
    directResponse: NextResponse.json(responsePayload, {
      status: 200,
      headers: getCorsHeaders('GET, POST, OPTIONS'),
    }),
  };
}
