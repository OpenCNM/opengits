'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  BookOpen, Terminal, Plus, Globe, Sparkles, Code2, Layers, Cpu,
  CheckCircle2, RefreshCw, FileCode2, ArrowRight, Zap, ChevronRight,
  ShieldCheck, FileText, Activity
} from 'lucide-react';
import { useSafeSession } from '@/lib/useSafeSession';
import { useGuestStore } from '@/lib/stores/guest-store';
import { DisplayRepo } from '@/lib/home-data';
import * as m from '@/paraglide/messages';

interface ExperienceItem {
  id: string;
  title: () => string;
  desc: () => string;
  tag: string;
  codeSnippet?: () => string;
}

interface PipelineStep {
  step: number;
  label: () => string;
  title: () => string;
  desc: () => string;
  articleTitle: () => string;
  prose: () => string;
  codePeek: () => string;
}

const BRAND_ITEMS = [
  { name: 'facebook/react', label: 'React', stars: '236k', category: 'Code' },
  { name: 'vercel/next.js', label: 'Next.js', stars: '128k', category: 'Code' },
  { name: 'tailwindlabs/tailwindcss', label: 'TailwindCSS', stars: '85k', category: 'Automate' },
  { name: 'vuejs/core', label: 'Vue.js', stars: '45k', category: 'Code' },
  { name: 'prisma/prisma', label: 'Prisma ORM', stars: '39k', category: 'Plan' },
  { name: 'fumadocs/fumadocs', label: 'Fumadocs', stars: '12k', category: 'Collaborate' },
  { name: 'inngest/inngest', label: 'Inngest', stars: '8k', category: 'Automate' },
  { name: 'elkjs/elk', label: 'ElkJS Graph', stars: '5k', category: 'Secure' },
];

const PIPELINE_CODE_BODIES: Record<number, string> = {
  1: 'export const astGraph = await treeSitter.parseRepo(repoTree);\nconst roots = astGraph.findTopologicalRoots();',
  2: 'function workLoopConcurrent() {\n  while (workInProgress !== null && !shouldYield()) {\n    performUnitOfWork(workInProgress);\n  }\n}',
  3: 'return (\n  <SwissArticleRenderer font="Mona-Sans" grid={true}>\n    {chapter.renderInteractiveArticle()}\n  </SwissArticleRenderer>\n);',
};

const PIPELINE_STEPS: PipelineStep[] = [
  {
    step: 1,
    label: m.bento_pipeline1_label,
    title: m.bento_pipeline1_title,
    desc: m.bento_pipeline1_desc,
    articleTitle: m.bento_pipeline1_article_title,
    prose: m.bento_pipeline1_prose,
    codePeek: () => `${m.bento_pipeline1_code_comment()}\n${PIPELINE_CODE_BODIES[1]}`,
  },
  {
    step: 2,
    label: m.bento_pipeline2_label,
    title: m.bento_pipeline2_title,
    desc: m.bento_pipeline2_desc,
    articleTitle: m.bento_pipeline2_article_title,
    prose: m.bento_pipeline2_prose,
    codePeek: () => `${m.bento_pipeline2_code_comment()}\n${PIPELINE_CODE_BODIES[2]}`,
  },
  {
    step: 3,
    label: m.bento_pipeline3_label,
    title: m.bento_pipeline3_title,
    desc: m.bento_pipeline3_desc,
    articleTitle: m.bento_pipeline3_article_title,
    prose: m.bento_pipeline3_prose,
    codePeek: () => `${m.bento_pipeline3_code_comment()}\n${PIPELINE_CODE_BODIES[3]}`,
  },
];

const mcpQuerySnippet = (title: string): string =>
  `search({ query: "${title}", mode: "architecture" })`;

interface BentoFeaturesSectionProps {
  repos?: DisplayRepo[];
}

export function BentoFeaturesSection({ repos = [] }: BentoFeaturesSectionProps = {}) {
  const router = useRouter();
  const { data: session } = useSafeSession();
  const isAuthenticated = Boolean(session?.user?.id);
  const isGuest = useGuestStore((s) => s.isGuest);

  const realTutorials = useMemo(() => {
    const validRepos = (repos || []).filter(
      (r) => r.isPublic && (r.chapterCount > 0 || r.processedDocsCount > 0 || (r.documents && r.documents.length > 0))
    );

    if (validRepos.length > 0) {
      return validRepos.map((r) => ({
        id: r.id,
        owner: r.owner,
        repo: r.repo,
        label: r.repoProfile?.titleZh || r.title || r.repo,
        slug: `${r.owner}/${r.repo}`,
        stars: r.starCount ? (r.starCount >= 1000 ? `${(r.starCount / 1000).toFixed(0)}k` : `${r.starCount}`) : '1k',
        chapterCount: r.chapterCount || r.processedDocsCount || 0,
        description: r.repoProfile?.summary || r.description || '',
      }));
    }

    return BRAND_ITEMS.map((b) => {
      const [owner, repo] = b.name.split('/');
      return {
        id: b.name,
        owner: owner || '',
        repo: repo || '',
        label: b.label,
        slug: b.name,
        stars: b.stars,
        chapterCount: 0,
        description: '',
      };
    });
  }, [repos]);

  const handleCardClick = (item: { owner: string; repo: string }) => {
    if (!isAuthenticated && !isGuest) {
      useGuestStore.getState().setGuestMode(true, `${item.owner}/${item.repo}`);
    }
    router.push(`/docs/${item.owner}/${item.repo}`);
  };

  const marqueeDuration = Math.max(25, realTutorials.length * 3.2);

  const [selectedLang, setSelectedLang] = useState<'zh' | 'en' | 'ja'>('zh');
  const [activeStep, setActiveStep] = useState<number>(2);

  const [experiences] = useState<ExperienceItem[]>([
    {
      id: '1',
      title: m.bento_exp1_title,
      desc: m.bento_exp1_desc,
      tag: 'RSC BOUNDARY',
      codeSnippet: () => mcpQuerySnippet(m.bento_exp1_code_title()),
    },
    {
      id: '2',
      title: m.bento_exp2_title,
      desc: m.bento_exp2_desc,
      tag: 'WORKLOOP INTERRUPT',
      codeSnippet: () => mcpQuerySnippet(m.bento_exp2_code_title()),
    },
    {
      id: '3',
      title: m.bento_exp3_title,
      desc: m.bento_exp3_desc,
      tag: 'CACHE REVALIDATION',
      codeSnippet: () => mcpQuerySnippet(m.bento_exp3_code_title()),
    },
  ]);

  const currentStepData = PIPELINE_STEPS[activeStep - 1];

  return (
    <div className="w-full pt-16 pb-12 relative font-sans space-y-24">

      <div className="max-w-7xl mx-auto px-4 md:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">

          <motion.section
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className="relative rounded-3xl border border-purple-500/30 bg-theme-surface p-6 md:p-8 shadow-2xl flex flex-col justify-between hover:border-purple-500/60 transition-colors overflow-hidden group"
          >
            <div className="absolute -top-24 -left-24 w-72 h-72 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />

            <div className="mb-6 relative z-10">
              <h2 className="text-2xl font-extrabold text-theme-foreground tracking-tight">
                {m.bento_gen_tutorial_title()}
              </h2>
            </div>

            <div className="relative z-10 rounded-2xl border border-theme-border bg-theme-bg overflow-hidden shadow-xl font-mono text-xs flex flex-col flex-1 min-h-[360px]">
              <div className="h-9 px-4 bg-theme-surface border-b border-theme-border flex items-center justify-between text-micro text-theme-muted">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 mr-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <span className="text-theme-foreground font-bold flex items-center gap-1">
                    <FileCode2 className="w-3 h-3 text-purple-400" /> tutorial-spec.md
                  </span>
                </div>
                <span className="text-emerald-400 font-bold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> AST INFERRED
                </span>
              </div>

              <div className="grid grid-cols-12 flex-1">
                <div className="col-span-4 border-r border-theme-border bg-theme-surface/50 p-3 space-y-2">
                  {PIPELINE_STEPS.map((s) => (
                    <button
                      key={s.step}
                      onClick={() => setActiveStep(s.step)}
                      className={`w-full text-left p-2.5 rounded-xl border transition-all text-micro space-y-1 block ${
                        activeStep === s.step
                          ? 'border-purple-500 bg-purple-500/10 text-purple-300 shadow-sm'
                          : 'border-transparent text-theme-muted hover:text-theme-foreground hover:bg-theme-bg'
                      }`}
                    >
                      <div className="font-bold flex items-center justify-between font-mono">
                        <span>STAGE 0{s.step}</span>
                        {activeStep === s.step && <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />}
                      </div>
                      <div className="font-sans font-medium line-clamp-1">{s.title()}</div>
                    </button>
                  ))}

                  <div className="mt-4 p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 text-micro text-purple-300 space-y-2">
                    <div className="flex items-center justify-between font-bold">
                      <span>{m.bento_transcribe_progress()}</span>
                      <span>100%</span>
                    </div>
                    <div className="w-full h-1.5 bg-theme-bg rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: '0%' }} 
                        animate={{ width: '100%' }} 
                        transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 3 }}
                        className="h-full bg-purple-500" 
                      />
                    </div>
                  </div>
                </div>

                <div className="col-span-8 p-4 bg-theme-bg text-micro leading-relaxed space-y-3 overflow-hidden flex flex-col justify-between">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={`step-${activeStep}-${selectedLang}`}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      transition={{ duration: 0.25 }}
                      className="space-y-2.5 font-sans flex-1 flex flex-col"
                    >
                      <div className="inline-block px-2 py-0.5 rounded bg-purple-500/20 text-purple-600 dark:text-purple-300 font-mono text-micro font-bold border border-purple-500/30 w-fit">
                        {currentStepData.label()}
                      </div>

                      <h3 className="text-base font-extrabold text-theme-foreground tracking-tight leading-snug">
                        {currentStepData.articleTitle()}
                      </h3>

                      <p className="text-xs text-theme-muted leading-relaxed font-sans flex-1">
                        {currentStepData.prose()}
                      </p>

                      <div className="p-2.5 rounded-xl bg-theme-surface border border-theme-border font-mono text-micro text-theme-foreground relative overflow-hidden max-h-[85px] shadow-sm">
                        <div className="text-purple-500 font-bold border-b border-theme-border pb-1 mb-1 flex items-center justify-between text-micro">
                          <span>// CODE PEEK</span>
                          <span className="text-theme-muted text-compact uppercase">{selectedLang}</span>
                        </div>
                        <pre className="text-emerald-600 dark:text-emerald-400 opacity-90 overflow-hidden line-clamp-2 text-micro">
                          <code>{currentStepData.codePeek()}</code>
                        </pre>
                        <div className="absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-theme-surface to-transparent pointer-events-none" />
                      </div>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            </div>

          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
            className="relative rounded-3xl border border-sky-500/30 bg-theme-surface p-6 md:p-8 shadow-2xl flex flex-col justify-between overflow-hidden group text-theme-foreground hover:border-sky-500/60 transition-colors"
          >
            <div className="absolute -top-24 -right-24 w-72 h-72 bg-sky-500/10 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-24 -left-24 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

            <div className="mb-6 relative z-10">
              <h2 className="text-2xl font-extrabold text-theme-foreground tracking-tight">
                {m.bento_mcp_experience_title()}
              </h2>
            </div>

            <div className="relative z-10 rounded-2xl border border-theme-border bg-theme-bg overflow-hidden shadow-xl font-mono text-xs flex flex-col flex-1 min-h-[360px]">
              <div className="h-9 px-4 bg-theme-surface border-b border-theme-border flex items-center justify-between text-micro text-theme-muted">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 mr-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <span className="text-theme-foreground font-bold flex items-center gap-1">
                    <Activity className="w-3 h-3 text-sky-500" /> mcp-search-stream.log
                  </span>
                </div>
                <span className="text-sky-600 dark:text-sky-400 font-bold flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5" />
                  LIVE FEED
                </span>
              </div>

              <div className="grid grid-cols-12 flex-1">
                <div className="col-span-5 border-r border-theme-border bg-theme-surface/50 p-3 space-y-3 text-micro">
                  <div className="text-sky-600 dark:text-sky-400 font-bold border-b border-theme-border pb-1.5 flex items-center justify-between">
                    <span>AGENT LOGS</span>
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  </div>

                  <div className="space-y-2 text-theme-muted leading-relaxed font-mono">
                    <div className="opacity-60">[14:02:11] Init MCP Collector...</div>
                    <div className="text-sky-600 dark:text-sky-400 font-bold">&gt; Hook: search(filter=&quot;architecture&quot;)</div>
                    <div className="text-emerald-600 dark:text-emerald-400">&gt; Captured 3 verified entries</div>
                  </div>
                </div>

                <div className="col-span-7 p-3 bg-theme-bg space-y-2.5 overflow-y-auto max-h-[300px] pr-2">
                  <AnimatePresence mode="popLayout">
                    {experiences.map(exp => (
                      <motion.div
                        layout
                        initial={{ opacity: 0, scale: 0.9, y: 15 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: -15 }}
                        transition={{ duration: 0.3 }}
                        key={exp.id}
                        className="p-3 rounded-xl bg-theme-surface border border-theme-border hover:border-sky-500/60 transition-all space-y-1.5 shadow-sm group"
                      >
                        <div className="flex items-center justify-between text-micro font-bold">
                          <span className="text-theme-foreground group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors line-clamp-1">{exp.title()}</span>
                          <span className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-300 text-micro border border-sky-500/20 shrink-0 font-mono">
                            {exp.tag}
                          </span>
                        </div>
                        <p className="text-micro text-theme-muted font-sans line-clamp-2 leading-relaxed">
                          {exp.desc()}
                        </p>
                        {exp.codeSnippet && (
                          <div className="p-1.5 rounded bg-theme-bg text-micro text-emerald-600 dark:text-emerald-400 font-mono border border-theme-border truncate">
                            {exp.codeSnippet()}
                          </div>
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            </div>

          </motion.section>

        </div>
      </div>

      <motion.section 
        id="curated-showcase"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="w-full pt-16 pb-20 border-t border-b border-theme-border/60 bg-gradient-to-b from-theme-bg via-theme-surface/40 to-theme-bg relative overflow-hidden"
      >
        <div className="max-w-7xl mx-auto px-4 md:px-8 text-center space-y-4 mb-8">
          <p className="text-xs sm:text-sm text-theme-muted max-w-2xl mx-auto font-sans leading-relaxed">
            {m.bento_brand_marquee_desc()}
          </p>
        </div>

        <div 
          className="w-full overflow-hidden relative py-6 pause-on-hover group/marquee"
          style={{ '--marquee-duration': `${marqueeDuration}s` } as React.CSSProperties}
        >
          <div className="absolute left-0 top-0 bottom-0 w-24 bg-gradient-to-r from-theme-bg to-transparent z-10 pointer-events-none" />
          <div className="absolute right-0 top-0 bottom-0 w-24 bg-gradient-to-l from-theme-bg to-transparent z-10 pointer-events-none" />

          <div className="animate-opengits-marquee flex items-center gap-6 sm:gap-8">
            {[...realTutorials, ...realTutorials].map((item, idx) => (
              <div
                key={`${item.slug}-${idx}`}
                onClick={() => handleCardClick(item)}
                className="w-[300px] sm:w-[340px] min-h-[155px] p-5 sm:p-6 rounded-2xl sm:rounded-3xl border border-theme-border/80 bg-theme-surface/90 hover:bg-theme-surface backdrop-blur-md flex flex-col justify-between hover:border-theme-primary/60 transition-all duration-300 shrink-0 shadow-2xs hover:shadow-xl cursor-pointer select-none group/card relative text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="text-base sm:text-lg font-bold font-mono text-theme-foreground group-hover/card:text-theme-primary transition-colors truncate block">
                      {item.label}
                    </span>
                    <span className="text-micro font-mono text-theme-muted bg-theme-bg px-2 py-0.5 rounded border border-theme-border inline-block truncate max-w-[190px] mt-1">
                      {item.slug}
                    </span>
                  </div>
                  <span className="text-xs font-mono font-bold text-amber-400 bg-amber-500/10 px-2.5 py-1 rounded-md border border-amber-500/20 flex items-center gap-1 shrink-0">
                    ★ {item.stars}
                  </span>
                </div>

                <p className="text-xs text-theme-muted line-clamp-2 leading-relaxed my-2">
                  {item.description || (item.chapterCount > 0 ? `${item.chapterCount} 章节系统级全景架构解析与交互式源码导读` : `${item.slug} 核心代码架构解析`)}
                </p>

                <div className="flex items-center justify-between pt-2 border-t border-theme-border/40 mt-auto">
                  <span className="text-micro font-mono text-theme-muted bg-theme-bg px-2 py-0.5 rounded border border-theme-border/60">
                    {item.chapterCount > 0 ? m.showcase_card_chapters({ count: item.chapterCount }) : '开源导读'}
                  </span>

                  <button
                    type="button"
                    className="h-8 sm:h-8.5 px-3.5 rounded-xl border border-theme-border/70 bg-transparent text-theme-muted group-hover/card:bg-theme-primary group-hover/card:!text-theme-primary-fg group-hover/card:border-theme-primary text-xs font-semibold flex items-center gap-1.5 shadow-none group-hover/card:shadow-xs transition-all duration-200 active:scale-95 cursor-pointer ml-auto"
                  >
                    <span className="group-hover/card:!text-theme-primary-fg transition-colors">{m.action_enter_view()}</span>
                    <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover/card:!text-theme-primary-fg group-hover/card:translate-x-0.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.section>

    </div>
  );
}
