'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import * as m from '@/paraglide/messages';

export function FaqAccordionSection() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const faqs = [
    { q: m.faq_q1(), a: m.faq_a1() },
    { q: m.faq_q2(), a: m.faq_a2() },
    { q: m.faq_q3(), a: m.faq_a3() },
  ];

  return (
    <motion.section 
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6 }}
      className="relative z-10 space-y-6 pt-24 pb-12"
    >
      <div className="max-w-3xl mx-auto px-4 md:px-8 space-y-6">
        <div className="text-center mb-8">
          <span className="text-micro font-mono text-sky-400 font-bold tracking-widest uppercase mb-2 block">
            {m.faq_section_badge()}
          </span>
          <h2 className="text-2xl md:text-3xl font-bold text-theme-foreground">
            {m.faq_section_title()}
          </h2>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, idx) => {
            const isOpen = openFaq === idx;
            return (
              <div key={faq.q} className="border border-theme-border rounded-2xl bg-theme-surface overflow-hidden">
                <button
                  onClick={() => setOpenFaq(isOpen ? null : idx)}
                  className="w-full p-6 text-left font-bold text-sm text-theme-foreground flex items-center justify-between gap-4 transition-colors hover:text-sky-400 cursor-pointer"
                >
                  <span>{faq.q}</span>
                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                  >
                    <ChevronDown className="w-4 h-4 text-theme-muted" />
                  </motion.div>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="content"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="px-6 pb-6 text-xs text-theme-muted leading-relaxed font-normal border-t border-theme-border pt-4">
                        {faq.a}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </motion.section>
  );
}

