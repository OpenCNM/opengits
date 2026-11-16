'use client';

import React from 'react';
import { motion } from 'framer-motion';
import * as m from '@/paraglide/messages';

export function CtaBannerSection() {
  return (
    <motion.section 
      initial={{ opacity: 0, scale: 0.95 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6 }}
      className="relative z-10 border-t border-theme-border bg-gradient-to-b from-theme-bg to-purple-500/5 py-20 mt-12 overflow-hidden"
    >
      <div className="max-w-4xl mx-auto px-4 md:px-8 text-center space-y-8">
        <motion.h2 
          initial={{ opacity: 0, y: 15 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="text-4xl md:text-5xl font-extrabold tracking-tight text-theme-foreground"
        >
          {m.cta_banner_title()}
        </motion.h2>
        <motion.button
          whileHover={{ scale: 1.06, y: -2 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="px-8 py-4 rounded-2xl bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg font-bold text-sm transition-colors shadow-xl font-sans cursor-pointer"
        >
          {m.cta_banner_btn()}
        </motion.button>
      </div>
    </motion.section>
  );
}

