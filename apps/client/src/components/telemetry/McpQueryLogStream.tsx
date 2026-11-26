'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Search, RotateCcw, Cpu, CheckCircle2, XCircle } from 'lucide-react';
import { ExplorePagination } from '@/components/marketplace/ExplorePagination';
import { McpQueryLogDetailDrawer, McpQueryLogItem } from './McpQueryLogDetailDrawer';
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxList, ComboboxItem, ComboboxEmpty } from '@/components/ui/combobox';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import * as m from '@/paraglide/messages';

export interface McpQueryLogStreamProps {
 repositoryId?: string;
 className?: string;
}

export function McpQueryLogStream({ repositoryId, className }: McpQueryLogStreamProps) {
 const [logs, setLogs] = useState<McpQueryLogItem[]>([]);
 const [loading, setLoading] = useState(true);
 const [page, setPage] = useState(1);
 const [totalPages, setTotalPages] = useState(1);
 const [total, setTotal] = useState(0);

 const [search, setSearch] = useState('');
 const [toolName, setToolName] = useState('');
 const [dimension, setDimension] = useState('');
 const [isBlindSpot, setIsBlindSpot] = useState(false);
 const [isErrorOnly, setIsErrorOnly] = useState(false);

 const [selectedLog, setSelectedLog] = useState<McpQueryLogItem | null>(null);

 const fetchLogs = useCallback(async () => {
 setLoading(true);
 try {
 const params = new URLSearchParams();
 params.set('page', page.toString());
 params.set('pageSize', '15');
 if (repositoryId) params.set('repositoryId', repositoryId);
 if (toolName) params.set('toolName', toolName);
 if (dimension) params.set('dimension', dimension);
 if (search) params.set('search', search);
 if (isBlindSpot) params.set('isBlindSpot', 'true');
 if (isErrorOnly) params.set('status', 'ERROR');

 const res = await fetch(`/api/mcp/query-logs?${params.toString()}`);
 if (!res.ok) throw new Error(m.telemetry_network_failed());
 const data = await res.json();
 const payload = data.data || data;
 setLogs(payload.logs || []);
 setTotalPages(payload.pagination?.totalPages || 1);
 setTotal(payload.pagination?.total || 0);
 } catch (err) {
 console.error('Failed to fetch query logs:', err);
 } finally {
 setLoading(false);
 }
 }, [page, repositoryId, toolName, dimension, search, isBlindSpot, isErrorOnly]);

 useEffect(() => {
 fetchLogs();
 }, [fetchLogs]);

 const handleResetFilters = () => {
 setSearch('');
 setToolName('');
 setDimension('');
 setIsBlindSpot(false);
 setIsErrorOnly(false);
 setPage(1);
 };

 return (
 <div className={`space-y-6 font-serif ${className || ''}`}>
 <div className="space-y-4 pb-2 border-b border-theme-border/30">
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
 <div>
 <h3 className="font-serif font-bold text-xl text-theme-foreground tracking-tight">
 {m.usage_mcp_details_link()}
 </h3>
 <p className="text-xs text-theme-muted mt-0.5">
 {m.mcp_log_subtitle({ total })}
 </p>
 </div>

 <button
 onClick={handleResetFilters}
 className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1 text-xs text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
 >
 <RotateCcw className="w-3.5 h-3.5" />
 {m.market_reset_filters()}
 </button>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 pt-2">
 <div className="relative">
 <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-theme-muted" />
 <input
 type="text"
 placeholder={m.placeholder_search()}
 value={search}
 onChange={(e) => { setSearch(e.target.value); setPage(1); }}
 className="w-full pl-8 pr-3 py-1.5 text-xs bg-theme-bg border border-theme-border/40 rounded text-theme-foreground focus:outline-none focus:border-theme-border transition-colors"
 />
 </div>

 <Combobox 
  value={toolName} 
  onValueChange={(val) => { setToolName(val || ''); setPage(1); }}
  >
  <ComboboxInput
  placeholder={m.mcp_log_all_tools()}
  className="w-full text-xs bg-theme-bg border border-theme-border/40 rounded text-theme-foreground focus:outline-none hover:border-theme-border transition-colors font-mono"
  />
  <ComboboxPopup className="bg-theme-bg border border-theme-border font-serif shadow-lg z-[120]">
  <ComboboxList className="max-h-60 overflow-y-auto">
  <ComboboxEmpty className="p-2 text-xs text-theme-muted">{m.empty_no_matches()}</ComboboxEmpty>
  <ComboboxItem value="" className="text-xs font-mono cursor-pointer hover:bg-theme-primary/10">
  {m.mcp_log_all_tools()}
  </ComboboxItem>
  {['search_docs', 'search_code', 'search_architecture', 'search_gotchas', 'get_document', 'list_documents'].map(tool => (
  <ComboboxItem key={tool} value={tool} className="text-xs font-mono cursor-pointer hover:bg-theme-primary/10">
  {tool}
  </ComboboxItem>
  ))}
  </ComboboxList>
  </ComboboxPopup>
  </Combobox>

 <select
 value={dimension}
 onChange={(e) => { setDimension(e.target.value); setPage(1); }}
 className="w-full px-3 py-1.5 text-xs bg-theme-bg border border-theme-border/40 rounded text-theme-foreground focus:outline-none hover:border-theme-border transition-colors cursor-pointer"
 >
 <option value="">{m.mcp_log_all_dimensions()}</option>
 <option value="architecture">{m.mcp_log_dim_architecture()}</option>
 <option value="code">{m.mcp_log_dim_code()}</option>
 <option value="gotchas">{m.mcp_log_dim_gotchas()}</option>
 <option value="prose">{m.mcp_log_dim_prose()}</option>
 </select>

 <label className="flex items-center gap-2 text-xs text-theme-foreground cursor-pointer select-none px-3 py-1.5 bg-theme-bg border border-theme-border/40 rounded hover:border-theme-border transition-colors">
 <input
 type="checkbox"
 checked={isBlindSpot}
 onChange={(e) => { setIsBlindSpot(e.target.checked); setPage(1); }}
 className="accent-theme-primary rounded"
 />
 <span className="font-medium">{m.mcp_log_filter_blindspot()}</span>
 </label>

 <label className="flex items-center gap-2 text-xs text-theme-foreground cursor-pointer select-none px-3 py-1.5 bg-theme-bg border border-theme-border/40 rounded hover:border-theme-border transition-colors">
 <input
 type="checkbox"
 checked={isErrorOnly}
 onChange={(e) => { setIsErrorOnly(e.target.checked); setPage(1); }}
 className="accent-theme-accent rounded"
 />
 <span className="font-medium text-theme-accent">{m.mcp_log_filter_errors()}</span>
 </label>
 </div>
 </div>

 <div className="p-0 overflow-hidden bg-theme-bg border border-theme-border/40 rounded-lg shadow-2xs">
 {loading ? (
 <div className="py-16 text-center text-theme-muted text-xs font-serif animate-pulse">
 {m.common_loading()}
 </div>
 ) : logs.length === 0 ? (
  <div className="py-24 text-center space-y-2 font-serif animate-in fade-in duration-300">
  <p className="text-base font-bold text-theme-foreground">{m.empty_no_data()}</p>
  </div>
 ) : (
        <Table className="w-full text-left text-xs">
          <TableHeader>
            <TableRow className="border-b border-theme-border/30 bg-theme-surface/20 text-theme-muted font-medium">
              <TableHead className="py-3 px-4 w-28 text-theme-muted">{m.mcp_log_th_time()}</TableHead>
              {!repositoryId && <TableHead className="py-3 px-4 w-36 text-theme-muted">{m.mcp_log_th_repo()}</TableHead>}
              <TableHead className="py-3 px-4 w-36 text-theme-muted">{m.mcp_log_th_tool()}</TableHead>
              <TableHead className="py-3 px-4 text-theme-muted">{m.mcp_log_th_query_summary()}</TableHead>
              <TableHead className="py-3 px-4 w-24 text-theme-muted">{m.mcp_log_th_dimension()}</TableHead>
              <TableHead className="py-3 px-4 w-20 text-center text-theme-muted">{m.mcp_log_th_hits()}</TableHead>
              <TableHead className="py-3 px-4 w-20 text-right text-theme-muted">{m.mcp_log_th_latency()}</TableHead>
              <TableHead className="py-3 px-4 w-24 text-center text-theme-muted">{m.mcp_log_th_status()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => {
              const dateStr = new Date(log.createdAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });

              return (
                <TableRow
                  key={log.id}
                  onClick={() => setSelectedLog(log)}
                  className={`group transition-colors cursor-pointer ${
                    log.status === 'ERROR'
                      ? 'bg-theme-accent/5 hover:bg-theme-accent/10'
                      : log.isBlindSpot
                      ? 'bg-theme-primary/5 hover:bg-theme-primary/10'
                      : 'hover:bg-theme-surface/30'
                  }`}
                >
                  <TableCell className="py-3 px-4 font-mono text-theme-muted whitespace-nowrap text-micro">
                    {dateStr}
                  </TableCell>

                  {!repositoryId && (
                    <TableCell className="py-3 px-4 font-mono text-theme-foreground font-medium truncate max-w-[140px]">
                      {log.repository ? `${log.repository.owner}/${log.repository.name}` : '—'}
                    </TableCell>
                  )}

                  <TableCell className="py-3 px-4 font-mono text-theme-foreground font-medium">
                    {log.toolName}
                    {log.isFallback ? (
                      <span
                        title={`${log.requestedEdition ?? '—'} → ${log.resolvedEdition ?? '—'}`}
                        className="ml-1.5 px-1.5 py-0.5 rounded text-micro font-mono border border-theme-accent/40 text-theme-accent"
                      >
                        {m.mcp_log_fallback_badge()}
                      </span>
                    ) : null}
                  </TableCell>

                  <TableCell className="py-3 px-4 text-theme-foreground font-serif truncate max-w-xs sm:max-w-md">
                    {log.query ? (
                      <span>&ldquo;{log.query}&rdquo;</span>
                    ) : (
                      <span className="text-theme-muted italic">{m.mcp_log_empty_query()}</span>
                    )}
                  </TableCell>

                  <TableCell className="py-3 px-4">
                    <span className="px-2 py-0.5 rounded text-micro font-mono text-theme-muted uppercase">
                      {log.dimension || 'all'}
                    </span>
                  </TableCell>

                  <TableCell className="py-3 px-4 text-center font-serif font-bold">
                    <span className={log.isBlindSpot ? 'text-theme-accent' : 'text-theme-foreground'}>
                      {log.resultCount}
                    </span>
                  </TableCell>

                  <TableCell className="py-3 px-4 text-right font-mono text-theme-muted text-micro">
                    {log.responseTimeMs ? `${log.responseTimeMs}ms` : '—'}
                  </TableCell>

                  <TableCell className="py-3 px-4 text-center">
                    {log.status === 'ERROR' ? (
                      <span className="inline-flex items-center gap-1 text-micro font-medium text-theme-accent">
                        <XCircle className="w-3 h-3" /> {m.status_failed()}
                      </span>
                    ) : log.isBlindSpot ? (
                      <span className="inline-flex items-center gap-1 text-micro font-medium text-theme-primary">
                        <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-pulse" /> {m.mcp_log_blindspot_badge()}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-micro font-medium text-theme-muted">
                        <CheckCircle2 className="w-3 h-3 text-theme-primary" /> ✓
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>

 {totalPages > 1 && (
 <ExplorePagination
 currentPage={page}
 totalPages={totalPages}
 onPageChange={(p) => setPage(p)}
 />
 )}

 <McpQueryLogDetailDrawer
 log={selectedLog}
 isOpen={!!selectedLog}
 onClose={() => setSelectedLog(null)}
 />
 </div>
 );
}
