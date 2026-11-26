'use client';

import React from 'react';
import { Terminal, Clock, CheckCircle2, XCircle, FileText, Database, ShieldAlert, Cpu } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetPanel } from '@/components/ui/sheet';
import * as m from '@/paraglide/messages';

export interface McpQueryLogItem {
 id: string;
 repositoryId?: string | null;
 repository?: {
 owner: string;
 name: string;
 } | null;
 toolName: string;
 query?: string | null;
 dimension?: string | null;
 tokenBudget: number;
 tokensReturned: number;
 resultCount: number;
 isBlindSpot: boolean;
 responseTimeMs?: number | null;
 status: string;
 requestedEdition?: string | null;
 resolvedEdition?: string | null;
 isFallback?: boolean | null;
 errorMessage?: string | null;
 resultSnapshot?: any;
 createdAt: string;
}

interface McpQueryLogDetailDrawerProps {
 log: McpQueryLogItem | null;
 isOpen: boolean;
 onClose: () => void;
}

export function McpQueryLogDetailDrawer({ log, isOpen, onClose }: McpQueryLogDetailDrawerProps) {
 if (!log) return null;

 const formattedDate = new Date(log.createdAt).toLocaleString('zh-CN', {
 year: 'numeric',
 month: '2-digit',
 day: '2-digit',
 hour: '2-digit',
 minute: '2-digit',
 second: '2-digit',
 });

 return (
 <Sheet open={isOpen} onOpenChange={onClose}>
 <SheetContent side="right" className="sm:max-w-xl w-full p-0 bg-theme-bg font-serif border-l border-theme-border">
 <SheetHeader className="border-b border-theme-border/40 pb-4 p-6 bg-theme-surface/40">
 <div className="flex items-center gap-2 mb-1 text-theme-primary">
 <Cpu size={16} />
 <span className="text-xs font-mono font-bold tracking-wider uppercase">
 {log.toolName}
 </span>
 </div>

 <SheetTitle className="text-xl font-serif font-bold text-theme-foreground">
 {m.mcp_log_detail_title()}
 </SheetTitle>

 <SheetDescription className="text-xs text-theme-muted flex items-center gap-2 mt-1">
 <Clock size={12} />
 <span>{m.mcp_log_executed_at({ time: formattedDate })}</span>
 </SheetDescription>
 </SheetHeader>

 <SheetPanel className="p-6 space-y-6 overflow-y-auto">
 <div className="grid grid-cols-2 gap-3">
 <div className="theme-surface-letterpress p-3.5 space-y-1">
 <span className="text-micro text-theme-muted block font-sans">{m.mcp_log_status_label()}</span>
 <div className="flex items-center gap-1.5 font-bold text-xs">
 {log.status === 'ERROR' ? (
 <span className="text-theme-accent flex items-center gap-1">
 <XCircle size={14} /> {m.status_failed()}
 </span>
 ) : (
 <span className="text-theme-primary flex items-center gap-1">
 <CheckCircle2 size={14} /> {m.mcp_log_status_success()}
 </span>
 )}
 </div>
 </div>

 <div className="theme-surface-letterpress p-3.5 space-y-1">
 <span className="text-micro text-theme-muted block font-sans">{m.mcp_log_th_latency()}</span>
 <div className="font-mono font-bold text-xs text-theme-foreground">
 {log.responseTimeMs ? `${log.responseTimeMs} ms` : '—'}
 </div>
 </div>
 </div>

 <div className="theme-surface-letterpress p-4 space-y-3">
 <h4 className="text-xs font-bold text-theme-foreground flex items-center gap-1.5 border-b border-theme-border/30 pb-2">
 <Terminal size={14} className="text-theme-primary" />
 {m.mcp_log_request_params()}
 </h4>

	 <div className="space-y-2 text-xs">
	 {log.query && (
	 <div>
	 <span className="text-theme-muted block text-micro mb-0.5">{m.mcp_log_query_label()}</span>
	 <p className="font-mono bg-theme-bg p-2 rounded border border-theme-border/60 text-theme-foreground break-all">
	 {log.query}
	 </p>
	 </div>
	 )}

 <div className="grid grid-cols-2 gap-2 pt-1">
 <div>
 <span className="text-theme-muted block text-micro">{m.mcp_log_target_repo()}</span>
 <span className="font-mono text-theme-foreground font-semibold">
 {log.repository ? `${log.repository.owner}/${log.repository.name}` : m.mcp_log_scope_global()}
 </span>
 </div>
 <div>
 <span className="text-theme-muted block text-micro">{m.mcp_log_th_dimension()}</span>
 <span className="font-mono text-theme-foreground font-semibold">
 {log.dimension || 'all'}
 </span>
 </div>
 {log.requestedEdition || log.resolvedEdition ? (
 <div className="col-span-2">
 <span className="text-theme-muted block text-micro">{m.mcp_log_th_edition()}</span>
 <span className="font-mono text-theme-foreground font-semibold">
 {log.requestedEdition ?? '—'} → {log.resolvedEdition ?? '—'}
 {log.isFallback ? ` · ${m.mcp_log_fallback_badge()}` : ''}
 </span>
 </div>
 ) : null}
 </div>
 </div>
 </div>

 <div className="theme-surface-letterpress p-4 space-y-3">
 <h4 className="text-xs font-bold text-theme-foreground flex items-center gap-1.5 border-b border-theme-border/30 pb-2">
 <Database size={14} className="text-theme-primary" />
 {m.mcp_log_result_title()}
 </h4>

 <div className="grid grid-cols-3 gap-2 text-center text-xs">
 <div className="bg-theme-bg p-2 rounded border border-theme-border/40">
 <span className="text-micro text-theme-muted block">{m.mcp_log_hit_count()}</span>
 <span className={`font-mono font-bold ${log.isBlindSpot ? 'text-theme-accent' : 'text-theme-foreground'}`}>
 {log.resultCount}
 </span>
 </div>
	 <div className="bg-theme-bg p-2 rounded border border-theme-border/40">
	 <span className="text-micro text-theme-muted block">{m.mcp_log_token_budget()}</span>
	 <span className="font-mono text-theme-foreground font-semibold">{log.tokenBudget || '—'}</span>
	 </div>
	 <div className="bg-theme-bg p-2 rounded border border-theme-border/40">
	 <span className="text-micro text-theme-muted block">{m.mcp_log_tokens_returned()}</span>
	 <span className="font-mono text-theme-foreground font-semibold">{log.tokensReturned || '—'}</span>
	 </div>
 </div>
 </div>

 {log.errorMessage && (
 <div className="theme-surface-letterpress p-4 space-y-2 border-theme-accent/40 bg-theme-accent/5">
 <h4 className="text-xs font-bold text-theme-accent flex items-center gap-1.5">
 <ShieldAlert size={14} />
 {m.mcp_log_error_details()}
 </h4>
 <pre className="text-xs font-mono text-theme-accent bg-theme-bg/80 p-3 rounded border border-theme-accent/30 whitespace-pre-wrap break-all">
 {log.errorMessage}
 </pre>
 </div>
 )}

 {log.resultSnapshot && (
 <div className="theme-surface-letterpress p-4 space-y-2">
 <h4 className="text-xs font-bold text-theme-foreground flex items-center gap-1.5">
 <FileText size={14} className="text-theme-primary" />
 {m.mcp_log_snapshot_title()}
 </h4>
 <pre className="text-micro font-mono text-theme-foreground bg-theme-bg p-3 rounded border border-theme-border/60 overflow-x-auto whitespace-pre-wrap">
 {JSON.stringify(log.resultSnapshot, null, 2)}
 </pre>
 </div>
 )}
 </SheetPanel>
 </SheetContent>
 </Sheet>
 );
}
