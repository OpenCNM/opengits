'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FolderGit2,
  Zap,
  RefreshCw,
  Copy,
  Globe,
  FileCode,
  ChevronLeft,
  Search,
  PanelLeft,
  Code2,
  Table as TableIcon,
  Lightbulb,
  AlertTriangle,
  Info,
  CheckCircle2,
} from 'lucide-react';
import * as m from '@/paraglide/messages';
import {
  CodexIcon,
  ClaudeCodeIcon,
  CursorIcon,
  VSCodeIcon,
  ZcodeIcon,
  AntigravityIcon,
} from '../icons';
import { useMcpFlowShowcaseSimulation } from '../hooks/useMcpFlowShowcaseSimulation';
import { getStoryDetailBlocks, type DetailBlock } from '../data/mcpShowcaseData';

function renderDetailBlock(block: DetailBlock, idx: number) {
  switch (block.type) {
    case 'code':
      return (
        <div
          key={idx}
          className="rounded-2xl border border-theme-border/80 bg-theme-surface/70 overflow-hidden shadow-xs flex flex-col min-h-0"
        >
          {/* Code Header Bar */}
          <div className="px-4 py-2 bg-theme-bg/60 border-b border-theme-border/60 flex items-center justify-between text-xs font-mono shrink-0 select-none">
            <div className="flex items-center gap-2 text-theme-foreground font-semibold">
              <Code2 className="w-3.5 h-3.5 text-purple-400" />
              <span>{block.lang}</span>
              <span className="text-theme-border">/</span>
              <span className="text-theme-muted">
                {m.mcp_showcase_code_lines({ count: block.linesCount })}
              </span>
            </div>
          </div>

          {/* Code Lines */}
          <div className="p-3.5 md:p-4 font-mono text-xs text-theme-foreground/90 space-y-1 overflow-x-hidden select-none">
            {block.snippet.map((line, lIdx) => (
              <div key={lIdx} className="flex items-start">
                <span className="w-6 text-right pr-3 text-theme-muted/40 shrink-0 select-none font-mono">
                  {lIdx + 1}
                </span>
                <span className="whitespace-pre overflow-hidden text-ellipsis font-mono">
                  {line}
                </span>
              </div>
            ))}
          </div>
        </div>
      );

    case 'table':
      return (
        <div
          key={idx}
          className="rounded-2xl border border-theme-border/80 bg-theme-surface/70 overflow-hidden shadow-xs flex flex-col min-h-0"
        >
          {block.title && (
            <div className="px-4 py-2.5 bg-theme-bg/60 border-b border-theme-border/60 flex items-center gap-2 text-xs font-mono font-bold text-theme-foreground select-none">
              <TableIcon className="w-3.5 h-3.5 text-indigo-400" />
              <span>{block.title}</span>
            </div>
          )}
          <div className="overflow-x-auto no-scrollbar">
            <table className="w-full text-left text-xs font-sans border-collapse">
              <thead>
                <tr className="border-b border-theme-border/60 bg-theme-bg/40 font-mono text-theme-muted">
                  {block.headers.map((h, hIdx) => (
                    <th key={hIdx} className="px-3.5 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/40 font-mono">
                {block.rows.map((row, rIdx) => (
                  <tr
                    key={rIdx}
                    className="hover:bg-theme-surface/60 transition-colors"
                  >
                    {row.map((cell, cIdx) => (
                      <td
                        key={cIdx}
                        className={`px-3.5 py-2 text-xs ${
                          cIdx === 0
                            ? 'font-medium text-theme-foreground'
                            : 'text-theme-muted'
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );

    case 'tip':
      return (
        <div
          key={idx}
          className={`rounded-2xl p-4 border flex gap-3 text-left shadow-xs ${
            block.variant === 'warning'
              ? 'bg-amber-500/10 border-amber-500/25 text-amber-200'
              : block.variant === 'info'
              ? 'bg-sky-500/10 border-sky-500/25 text-sky-200'
              : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200'
          }`}
        >
          <div className="shrink-0 mt-0.5">
            {block.variant === 'warning' ? (
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            ) : block.variant === 'info' ? (
              <Info className="w-4 h-4 text-sky-400" />
            ) : (
              <Lightbulb className="w-4 h-4 text-emerald-400" />
            )}
          </div>
          <div className="space-y-1 min-w-0 font-sans">
            <h5 className="font-bold text-xs tracking-tight text-theme-foreground">
              {block.title}
            </h5>
            <p className="text-xs text-theme-muted leading-relaxed">
              {block.content}
            </p>
          </div>
        </div>
      );

    case 'summary':
      return (
        <div
          key={idx}
          className="rounded-2xl p-4 border border-purple-500/25 bg-theme-surface/80 space-y-2.5 shadow-xs text-left font-sans"
        >
          <div className="flex items-center gap-2 text-xs font-bold text-purple-400 font-mono">
            <CheckCircle2 className="w-4 h-4 text-purple-400" />
            <span>{block.title}</span>
          </div>
          <div className="space-y-1.5 text-xs text-theme-muted">
            {block.items.map((item, iIdx) => (
              <div key={iIdx} className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-1.5 shrink-0" />
                <span className="leading-relaxed text-theme-foreground/90">{item}</span>
              </div>
            ))}
          </div>
        </div>
      );
  }
}

export function McpFlowShowcase() {
  const {
    containerRef,
    scrollContainerRef,
    stage,
    typedUrl,
    copied,
    currentData,
    layoutSeed,
    handleCopyCommand,
  } = useMcpFlowShowcaseSimulation();

  const allChapters = currentData.modules.flatMap((mod) => mod.chapters);
  const detailBlocks = getStoryDetailBlocks(currentData, layoutSeed);

  return (
    <div
      ref={containerRef}
      className="max-w-[1408px] mx-auto px-4 md:px-8 relative z-20 py-4 font-sans text-left select-none cursor-default"
    >
      {/* Main Showcase Window with Ambient Mood Glow */}
      <div
        className={`rounded-[28px] md:rounded-[36px] border border-theme-border bg-theme-surface shadow-[0_20px_80px_rgba(0,0,0,0.6)] overflow-hidden backdrop-blur-2xl flex flex-col font-sans h-[720px] relative select-none cursor-default transition-colors duration-700 ${
          stage === 1
            ? 'bg-gradient-to-b from-purple-500/5 via-theme-surface to-theme-surface'
            : stage === 2
            ? 'bg-gradient-to-b from-indigo-500/5 via-theme-surface to-theme-surface'
            : stage === 3
            ? 'bg-gradient-to-b from-blue-500/5 via-theme-surface to-theme-surface'
            : 'bg-gradient-to-b from-emerald-500/5 via-theme-surface to-theme-surface'
        }`}
      >
        {/* Transparent Non-Interactive Protective Shield */}
        <div
          className="absolute inset-0 z-40 bg-transparent cursor-default pointer-events-auto select-none"
          aria-hidden="true"
        />

        {/* Window Header Bar */}
        <div className="p-3.5 md:p-4 border-b border-theme-border/70 bg-theme-bg/90 flex items-center justify-between gap-3 text-xs font-mono shrink-0 select-none">
          {/* macOS window control dots */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="w-3 h-3 rounded-full bg-rose-500/80 inline-block" />
            <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block" />
            <span className="w-3 h-3 rounded-full bg-emerald-500/80 inline-block" />
          </div>

          {/* Concise Center Step Title */}
          <AnimatePresence mode="wait">
            <motion.div
              key={`header-step-${stage}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
              className="font-sans text-xs md:text-sm font-semibold text-theme-foreground/90 flex items-center gap-2"
            >
              <span
                className={`w-2 h-2 rounded-full animate-pulse shrink-0 ${
                  stage === 4 ? 'bg-emerald-400' : 'bg-purple-400'
                }`}
              />
              {stage === 1 && <span>{m.mcp_showcase_step1_header()}</span>}
              {stage === 2 && <span>{m.mcp_showcase_step2_header()}</span>}
              {stage === 3 && <span>{m.mcp_showcase_step3_header()}</span>}
              {stage === 4 && <span>{m.mcp_showcase_step4_header()}</span>}
            </motion.div>
          </AnimatePresence>

          {/* Balanced spacer for header center alignment */}
          <div className="w-12 shrink-0" />
        </div>

        {/* AnimatePresence for Smooth Stage Transitions */}
        <AnimatePresence mode="wait">
          {/* STAGE 1: Centered Big Demo Showcase Card */}
          {stage === 1 && (
            <motion.div
              key="stage-1"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.98 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="h-full flex flex-col items-center justify-center p-6 md:p-12 text-center bg-theme-bg relative space-y-6"
            >
              <motion.h3
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1, duration: 0.3 }}
                className="text-2xl md:text-3xl font-bold text-theme-foreground font-sans tracking-tight"
              >
                {m.mcp_showcase_stage1_title()}
              </motion.h3>

              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.15, duration: 0.35 }}
                className="w-full max-w-xl p-5 md:p-7 rounded-2xl bg-theme-surface border border-purple-500/30 shadow-[0_12px_40px_rgba(168,85,247,0.12)] text-left font-mono space-y-3.5"
              >
                <div className="flex items-center justify-between text-xs text-theme-muted font-medium">
                  <span className="flex items-center gap-2 text-purple-400 font-semibold">
                    {currentData.isWeb ? (
                      <Globe className="w-4 h-4 text-sky-400" />
                    ) : (
                      <FolderGit2 className="w-4 h-4" />
                    )}
                    {currentData.isWeb
                      ? m.mcp_showcase_target_web()
                      : m.mcp_showcase_target_repo()}
                  </span>
                  <span className="text-emerald-400 font-semibold flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    {currentData.isWeb
                      ? m.mcp_showcase_parsing_web()
                      : m.mcp_showcase_parsing_ast()}
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-theme-bg border border-theme-border text-base md:text-lg text-theme-foreground font-bold truncate flex items-center">
                  <span>{typedUrl}</span>
                  <span className="inline-block w-2 h-5 bg-purple-400 ml-1.5 animate-pulse rounded-xs" />
                </div>
              </motion.div>
            </motion.div>
          )}

          {/* STAGE 2: Streamlined Clean Scrolling Tutorial Page */}
          {stage === 2 && (
            <motion.div
              key="stage-2"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              ref={scrollContainerRef}
              className="flex-1 p-5 md:p-8 bg-theme-bg overflow-y-auto no-scrollbar space-y-4 text-left relative"
            >
              <div className="space-y-4 pb-4 max-w-4xl mx-auto">
                {/* Tutorial Header */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.08, duration: 0.3 }}
                  className="space-y-2 border-b border-theme-border/60 pb-3.5"
                >
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="flex items-center gap-1.5 bg-theme-surface border border-theme-border px-3 py-1 rounded-full text-theme-foreground font-semibold shadow-2xs">
                      {currentData.isWeb ? (
                        <Globe className="w-3.5 h-3.5 text-sky-400" />
                      ) : (
                        <FolderGit2 className="w-3.5 h-3.5 text-purple-400" />
                      )}
                      {currentData.repoName}
                    </span>
                    <span className="text-emerald-400 font-semibold bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
                      ★ {currentData.stars}
                    </span>
                  </div>

                  <h2 className="text-xl md:text-2xl font-extrabold text-theme-foreground font-sans leading-tight tracking-tight">
                    {currentData.tutorialTitle}
                  </h2>
                  <p className="text-xs md:text-sm text-theme-muted font-sans leading-relaxed">
                    {currentData.subtitle}
                  </p>
                </motion.div>

                {/* Categorized Modules & Clean Chapter Tree */}
                <div className="space-y-2.5 font-sans">
                  {currentData.modules.map((mod, modIdx) => (
                    <motion.div
                      key={modIdx}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.06 + modIdx * 0.04, duration: 0.25 }}
                      className="rounded-2xl border border-theme-border/80 bg-theme-surface/90 overflow-hidden shadow-xs hover:border-purple-500/40 transition-colors"
                    >
                      {/* Module Category Bar */}
                      <div className="px-3.5 py-2 md:px-4 md:py-2 bg-theme-bg/60 border-b border-theme-border/60 flex items-center justify-between gap-3 select-none">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-2 h-2 rounded-full bg-purple-400 shrink-0" />
                          <h4 className="font-sans font-bold text-xs md:text-sm text-theme-foreground truncate">
                            {mod.name}
                          </h4>
                        </div>
                        <span className="text-xs font-mono text-emerald-400 font-semibold bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 shrink-0 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          {m.mcp_showcase_lessons_count({ count: mod.chapters.length })}
                        </span>
                      </div>

                      {/* Clean Chapter Rows */}
                      <div className="p-1.5 md:p-2 space-y-1 bg-theme-surface/40">
                        {mod.chapters.map((ch, chIdx) => {
                          const match = ch.title.match(/^(\d+)\.\s*(.*)$/);
                          const chNum = match ? match[1] : String(chIdx + 1).padStart(2, '0');
                          const cleanTitle = match ? match[2] : ch.title;
                          return (
                            <div
                              key={chIdx}
                              className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-xl bg-theme-bg/80 border border-theme-border/70 hover:border-purple-500/40 transition-colors"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span className="w-5 h-5 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-400 font-mono text-xs font-bold flex items-center justify-center shrink-0">
                                  {chNum}
                                </span>
                                <span className="font-semibold text-xs md:text-sm text-theme-foreground truncate">
                                  {cleanTitle}
                                </span>
                              </div>
                              {ch.file && (
                                <span className="text-xs font-mono text-theme-muted hidden sm:flex items-center gap-1.5 bg-theme-surface px-2 py-0.5 rounded-md border border-theme-border/60 shrink-0">
                                  <FileCode className="w-3.5 h-3.5 text-purple-400" />
                                  {ch.file}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {/* STAGE 3: Two-Column Chapter Detail Reader with Masked Teaser */}
          {stage === 3 && (
            <motion.div
              key="stage-3"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="flex-1 flex overflow-hidden bg-theme-bg text-left relative font-sans"
            >
              {/* Left Column: Chapter Navigation Sidebar */}
              <div className="w-56 sm:w-64 md:w-72 border-r border-theme-border/70 bg-theme-surface/30 p-3.5 md:p-4 space-y-3 shrink-0 flex flex-col overflow-hidden select-none">
                {/* Repo Header */}
                <div className="flex items-center justify-between text-xs font-mono text-theme-foreground/90 pb-2 border-b border-theme-border/60">
                  <div className="flex items-center gap-1.5 truncate">
                    <ChevronLeft className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                    <span className="font-semibold uppercase tracking-wider truncate text-xs">
                      {currentData.repoName}
                    </span>
                  </div>
                  <PanelLeft className="w-3.5 h-3.5 text-theme-muted/70 shrink-0" />
                </div>

                {/* Search Box Mock */}
                <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-theme-bg/80 border border-theme-border/70 text-xs text-theme-muted select-none">
                  <div className="flex items-center gap-2">
                    <Search className="w-3.5 h-3.5 text-theme-muted" />
                    <span className="text-xs">{m.mcp_showcase_sidebar_search()}</span>
                  </div>
                  <kbd className="px-1.5 py-0.5 rounded bg-theme-surface border border-theme-border/80 text-xs font-mono text-theme-muted">
                    ⌘K
                  </kbd>
                </div>

                {/* Chapter List (01 - 08) */}
                <div className="flex-1 space-y-1 overflow-y-auto no-scrollbar pt-1 font-sans">
                  {allChapters.map((ch, idx) => {
                    const match = ch.title.match(/^(\d+)\.\s*(.*)$/);
                    const chNum = match ? match[1] : String(idx + 1).padStart(2, '0');
                    const cleanTitle = match ? match[2] : ch.title;
                    const isActive = idx === 0;

                    return (
                      <div
                        key={idx}
                        className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl text-xs transition-colors ${
                          isActive
                            ? 'bg-theme-surface border border-theme-border/90 text-theme-foreground font-semibold shadow-2xs'
                            : 'text-theme-muted hover:text-theme-foreground/90'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`font-mono text-xs shrink-0 ${
                              isActive ? 'text-purple-400 font-bold' : 'text-theme-muted/70'
                            }`}
                          >
                            {chNum}
                          </span>
                          <span className="truncate">{cleanTitle}</span>
                        </div>
                        {isActive && (
                          <span className="font-mono text-xs text-emerald-400 font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 shrink-0">
                            100%
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Chapter Detail Reading Pane - Full Display */}
              <div className="flex-1 p-5 md:p-8 bg-theme-bg overflow-y-auto no-scrollbar relative space-y-3.5 text-left font-sans flex flex-col">
                {/* Analogy Paragraph */}
                <p className="text-xs md:text-sm text-theme-foreground/85 leading-relaxed font-sans">
                  {currentData.detailPreview.analogy}
                </p>

                {/* Step Title */}
                <h3 className="text-base md:text-lg font-bold text-theme-foreground tracking-tight font-sans">
                  {currentData.detailPreview.stepTitle}
                </h3>

                {/* Explanation */}
                <p className="text-xs md:text-sm text-theme-muted leading-relaxed font-sans">
                  {currentData.detailPreview.explanation}
                </p>

                {/* Dynamic Pedagogical Content Blocks (Code, Table, Tip, Summary) */}
                <div className="space-y-3.5 flex-1 flex flex-col min-h-0 pt-1">
                  {detailBlocks.map((block, bIdx) => renderDetailBlock(block, bIdx))}
                </div>
              </div>
            </motion.div>
          )}

          {/* STAGE 4: Streamlined Big Icons & Focused MCP Showcase */}
          {stage === 4 && (
            <motion.div
              key="stage-4"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="h-full flex flex-col bg-theme-bg p-6 md:p-10 justify-between overflow-y-auto space-y-6 font-sans relative"
            >
              {/* Top / Center: Big App Icons Array */}
              <div className="space-y-4 shrink-0 my-auto">
                <div className="text-center space-y-1">
                  <h3 className="text-2xl md:text-3xl font-bold text-theme-foreground font-sans tracking-tight">
                    {m.mcp_showcase_stage3_title()}
                  </h3>
                  <p className="text-sm text-theme-muted font-sans">
                    {m.mcp_showcase_stage3_subtitle()}
                  </p>
                </div>

                {/* Prominent Large App Icons */}
                <div className="flex flex-wrap items-center justify-center gap-6 md:gap-9 py-4">
                  {[
                    { label: 'Zcode', component: ZcodeIcon },
                    { label: 'Codex', component: CodexIcon },
                    { label: 'Claude Code', component: ClaudeCodeIcon },
                    { label: 'Cursor', component: CursorIcon },
                    { label: 'VS Code', component: VSCodeIcon },
                    { label: 'Antigravity', component: AntigravityIcon },
                  ].map((item, idx) => {
                    const IconComp = item.component;
                    return (
                      <motion.div
                        key={item.label}
                        initial={{ opacity: 0, y: 16, scale: 0.85 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{
                          delay: 0.1 + idx * 0.05,
                          type: 'spring',
                          stiffness: 300,
                          damping: 20,
                        }}
                        className="flex flex-col items-center gap-2 group"
                      >
                        <IconComp className="w-16 h-16 md:w-20 md:h-20" />
                        <span className="text-xs font-mono font-bold text-theme-foreground">
                          {item.label}
                        </span>
                      </motion.div>
                    );
                  })}
                </div>
              </div>

              {/* Middle: Clean Live Context Injection Card */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.35 }}
                className="w-full max-w-2xl mx-auto p-4 md:p-5 rounded-2xl bg-theme-surface border border-purple-500/25 shadow-xl space-y-3 font-mono text-left"
              >
                <div className="flex items-center justify-between text-xs text-purple-400 font-bold border-b border-theme-border/60 pb-2">
                  <span className="flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-purple-400" /> {m.mcp_showcase_live_demo()}
                  </span>
                  <span className="text-emerald-400 font-bold">
                    {m.mcp_showcase_context_injected()}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-theme-bg border border-theme-border text-xs md:text-sm text-theme-foreground font-mono">
                  <span className="text-purple-400 font-bold">{m.mcp_showcase_prompt_label()}</span>{' '}
                  {m.mcp_showcase_prompt_example({ repoName: currentData.repoName })}
                </div>

                <div className="p-3.5 rounded-xl bg-purple-950/20 border border-purple-500/30 text-xs md:text-sm text-theme-foreground font-sans leading-relaxed">
                  <span className="font-bold text-purple-300 block mb-1 font-mono text-xs">
                    {m.mcp_showcase_mcp_response()}
                  </span>
                  {currentData.subtitle}
                </div>
              </motion.div>

              {/* Bottom Command Box */}
              <div className="w-full max-w-xl mx-auto flex items-center justify-between p-2.5 rounded-xl bg-theme-surface border border-theme-border font-mono text-xs shrink-0">
                <span className="text-theme-muted pl-2 text-xs">$ npx @opengits/mcp-server</span>
                <button
                  onClick={handleCopyCommand}
                  className="px-3.5 py-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 transition-all text-xs font-bold flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copied ? m.mcp_showcase_copied() : m.mcp_showcase_copy_cmd()}</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
