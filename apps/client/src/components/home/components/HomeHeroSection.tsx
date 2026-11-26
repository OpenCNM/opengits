'use client';

import React from 'react';
import { motion, Variants, useScroll, useTransform } from 'framer-motion';
import { ArrowRight, ChevronDown, Compass, GitBranch, Sparkles, X, Globe } from 'lucide-react';
import { SAMPLE_REPOS } from '../types';

import { Button } from '@/components/ui/button';
import * as m from '@/paraglide/messages';

interface HomeHeroSectionProps {
  heroPhysics?: { scale: number; opacity: number; translateY: number };
  inputUrl: string;
  setInputUrl: (val: string) => void;
  handleImportSubmit: (e?: React.FormEvent) => void;
  handleSuggestionClick: (url: string) => void;
  onExploreGuest?: () => void;
  reposCount?: number | string;
}

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.1,
    },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

export function HomeHeroSection({
  inputUrl,
  setInputUrl,
  handleImportSubmit,
  handleSuggestionClick,
  onExploreGuest,
  reposCount,
}: HomeHeroSectionProps) {
  const { scrollY } = useScroll();

  const displayCount = React.useMemo(() => {
    if (typeof reposCount === 'number' && reposCount > 0) {
      return reposCount >= 10 ? `${Math.floor(reposCount / 10) * 10}+` : `${reposCount}+`;
    }
    if (typeof reposCount === 'string' && reposCount) {
      return reposCount;
    }
    return '100+';
  }, [reposCount]);

  const heroScale = useTransform(scrollY, [0, 480], [1, 0.86]);
  const heroOpacity = useTransform(scrollY, [0, 260, 460], [1, 0.55, 0]);
  const heroY = useTransform(scrollY, [0, 480], [0, 42]);
  const heroBlur = useTransform(scrollY, [0, 240, 440], ["blur(0px)", "blur(2px)", "blur(8px)"]);
  const indicatorOpacity = useTransform(scrollY, [0, 90], [1, 0]);

  const handleScrollToDemo = () => {
    const el = document.getElementById('cinematic-agent-demo-stage');
    if (el) {
      const rect = el.getBoundingClientRect();
      const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
      const headerHeight = 64;
      const availableHeight = window.innerHeight - headerHeight;
      const centerOffset = Math.max(16, (availableHeight - rect.height) / 2);
      const targetY = currentScroll + rect.top - headerHeight - centerOffset;

      window.scrollTo({
        top: Math.max(0, targetY),
        behavior: 'smooth',
      });
    }
  };

  return (
    <motion.div 
      style={{
        scale: heroScale,
        opacity: heroOpacity,
        y: heroY,
        filter: heroBlur,
      }}
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="relative w-full max-w-5xl mx-auto px-4 text-center transform-gpu will-change-transform min-h-[calc(100vh-8rem)] flex flex-col items-center justify-center"
    >
      <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8 my-auto pb-14 sm:pb-16">

        <div className="space-y-6 sm:space-y-8">
          <motion.h1 
            variants={itemVariants}
            className="font-sans text-center tracking-tight leading-[1.12] select-none"
          >
            <span className="block text-3xl sm:text-5xl md:text-6xl lg:text-[4.25rem] font-extrabold tracking-[-0.03em] text-theme-foreground">
              {m.home_hero_title_primary()}
            </span>

            <span className="block mt-2.5 sm:mt-3.5 text-xl sm:text-3xl md:text-4xl lg:text-[2.65rem] font-semibold tracking-tight text-theme-foreground/85">
              {m.home_hero_title_secondary()}
            </span>
          </motion.h1>

          <motion.p 
            variants={itemVariants}
            className="text-base sm:text-lg text-theme-muted max-w-xl mx-auto font-normal leading-relaxed"
          >
            {m.home_hero_subtitle()}
          </motion.p>
        </div>

        <motion.div variants={itemVariants} className="max-w-3xl mx-auto pt-3 sm:pt-4">
          <div className="relative group">
            <div className="absolute -inset-1 sm:-inset-1.5 rounded-3xl sm:rounded-[2rem] bg-gradient-to-r from-theme-primary/15 via-theme-accent/10 to-theme-primary/15 blur-xl opacity-40 group-hover:opacity-70 group-focus-within:opacity-100 group-focus-within:blur-2xl transition-all duration-500 pointer-events-none" />

            <form
              onSubmit={handleImportSubmit}
              className="relative p-2 sm:p-2.5 bg-theme-surface/90 border border-theme-border/90 rounded-2xl sm:rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] dark:shadow-[0_12px_40px_rgb(0,0,0,0.35)] hover:shadow-[0_12px_40px_rgb(0,0,0,0.1)] flex items-center gap-2 sm:gap-3 backdrop-blur-2xl transition-all duration-300 group-hover:border-theme-border focus-within:border-theme-primary/40 focus-within:ring-4 focus-within:ring-theme-primary/10 focus-within:shadow-[0_16px_48px_rgb(0,0,0,0.12)]"
            >
              <div className="pl-3 sm:pl-4 text-theme-muted/70 group-focus-within:text-theme-foreground transition-colors flex items-center justify-center shrink-0">
                <GitBranch className="w-5 h-5 sm:w-5.5 sm:h-5.5" />
              </div>

              <input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder={m.placeholder_repo_url()}
                className="w-full bg-transparent border-none outline-none ring-0 shadow-none py-2.5 sm:py-3.5 px-1 sm:px-2 text-sm sm:text-base md:text-lg font-sans text-theme-foreground placeholder:text-theme-muted/50 focus:outline-none focus:ring-0"
              />

              {inputUrl && (
                <button
                  type="button"
                  onClick={() => setInputUrl('')}
                  className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-border/30 transition-colors shrink-0 cursor-pointer"
                  title={m.search_clear()}
                >
                  <X className="w-4 h-4" />
                </button>
              )}

              <Button
                type="submit"
                size="lg"
                className="h-11 sm:h-13 px-6 sm:px-8 bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg font-semibold text-sm sm:text-base rounded-xl sm:rounded-2xl transition-all shrink-0 shadow-md hover:shadow-xl active:scale-[0.98] font-sans flex items-center gap-2 group/btn cursor-pointer"
              >
                <span>{m.common_start()}</span>
                <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5 group-hover/btn:translate-x-0.5 transition-transform" />
              </Button>
            </form>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-2.5 mt-6 sm:mt-8 text-xs text-theme-muted">
            <span className="font-mono text-xs text-theme-muted/80 mr-1 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-theme-accent/80" />
              <span>{m.filter_recommend()}:</span>
            </span>
            {SAMPLE_REPOS.map(s => (
              <motion.button
                key={s.label}
                type="button"
                whileHover={{ scale: 1.04, y: -1 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => handleSuggestionClick(s.url)}
                className="px-3.5 py-1.5 rounded-xl border border-theme-border/80 bg-theme-surface/70 hover:bg-theme-surface hover:border-theme-primary/40 hover:text-theme-foreground transition-all font-mono text-xs text-theme-muted shadow-2xs hover:shadow-xs cursor-pointer flex items-center gap-1.5 backdrop-blur-xs"
              >
                {s.isWeb ? (
                  <Globe className="w-3 h-3 text-sky-400 shrink-0" />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-theme-primary/40" />
                )}
                <span>{s.label}</span>
              </motion.button>
            ))}
          </div>

          {onExploreGuest && (
            <motion.div
              variants={itemVariants}
              className="flex items-center justify-center pt-5 sm:pt-6"
            >
              <button
                type="button"
                onClick={onExploreGuest}
                className="group inline-flex items-center gap-2.5 px-4 sm:px-5 py-2 sm:py-2.5 rounded-full border border-theme-border/80 bg-theme-surface/70 hover:bg-theme-surface hover:border-theme-primary/50 text-xs sm:text-sm font-medium text-theme-foreground/85 hover:text-theme-foreground transition-all duration-300 shadow-2xs hover:shadow-md backdrop-blur-md cursor-pointer select-none active:scale-[0.98]"
              >
                <Compass className="w-4 h-4 text-theme-primary group-hover:rotate-45 transition-transform duration-500 shrink-0" />
                <span>{m.home_hero_guest_explore({ count: displayCount })}</span>
                <ArrowRight className="w-3.5 h-3.5 text-theme-muted group-hover:text-theme-foreground group-hover:translate-x-0.5 transition-all duration-300 shrink-0" />
              </button>
            </motion.div>
          )}
        </motion.div>
      </div>

      <motion.div
        style={{ opacity: indicatorOpacity }}
        variants={itemVariants}
        className="absolute bottom-2 sm:bottom-4 left-1/2 -translate-x-1/2 flex justify-center z-10"
      >
        <button
          type="button"
          onClick={handleScrollToDemo}
          className="group flex flex-col items-center gap-1.5 text-theme-muted/60 hover:text-theme-foreground transition-colors cursor-pointer select-none focus:outline-none"
          aria-label={m.home_hero_explore_demo()}
        >
          <span className="text-xs font-mono tracking-wider uppercase opacity-60 group-hover:opacity-100 transition-opacity">
            {m.home_hero_explore_demo()}
          </span>
          <motion.div
            animate={{ y: [0, 4, 0] }}
            transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
            className="w-8 h-8 rounded-full border border-theme-border/70 bg-theme-surface/60 backdrop-blur-xs flex items-center justify-center shadow-2xs group-hover:border-theme-primary/40 group-hover:bg-theme-surface group-hover:text-theme-primary group-hover:shadow-xs transition-all"
          >
            <ChevronDown className="w-4 h-4 transition-transform group-hover:translate-y-0.5" />
          </motion.div>
        </button>
      </motion.div>
    </motion.div>
  );
}
