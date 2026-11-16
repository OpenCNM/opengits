'use client';

import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Sparkles } from 'lucide-react';

export type InkSpiritState = 
  | 'idle' | 'sleeping' | 'dosing' | 'indifferent' | 'focused' | 'listening'
  | 'thinking' | 'typing' | 'dizzy' | 'bored'
  | 'excited' | 'proud' | 'worried' | 'sad' | 'surprised'
  | 'reading' | 'cheering' | 'shy';

interface InkSpiritAvatarProps {
  state: InkSpiritState;
  className?: string;
}

export function InkSpiritAvatar({ state, className }: InkSpiritAvatarProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Magnetic 3D Gyroscope hover effect
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const springConfig = { damping: 25, stiffness: 200 };
  const rotateX = useSpring(useTransform(mouseY, [-60, 60], [12, -12]), springConfig);
  const rotateY = useSpring(useTransform(mouseX, [-60, 60], [-12, 12]), springConfig);
  const translateX = useSpring(useTransform(mouseX, [-60, 60], [-3, 3]), springConfig);
  const translateY = useSpring(useTransform(mouseY, [-60, 60], [-3, 3]), springConfig);

  // Macro state categorization
  const isThinking = ['thinking', 'typing'].includes(state);
  const isWarning = ['worried', 'sad', 'dizzy'].includes(state);
  const isSuccess = ['cheering', 'excited', 'proud', 'surprised'].includes(state);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = e.clientX - centerX;
      const dy = e.clientY - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 120) {
        mouseX.set(dx);
        mouseY.set(dy);
      } else {
        mouseX.set(0);
        mouseY.set(0);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [mouseX, mouseY]);

  return (
    <motion.div
      ref={containerRef}
      style={{
        rotateX,
        rotateY,
        x: translateX,
        y: translateY,
        transformStyle: 'preserve-3d',
      }}
      className={cn(
        "relative w-9 h-9 flex items-center justify-center select-none rounded-full transition-all duration-300",
        "bg-theme-bg/95 border border-theme-border/60 backdrop-blur-md shadow-md hover:shadow-lg hover:scale-105 hover:border-theme-primary/60",
        className
      )}
    >
      {/* Dynamic AI Pulse Halo */}
      {isThinking && (
        <motion.div
          animate={{ scale: [1, 1.35, 1], opacity: [0.3, 0.75, 0.3] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-full bg-theme-primary/30 blur-sm pointer-events-none"
        />
      )}

      {isSuccess && (
        <motion.div
          animate={{ scale: [1, 1.4, 1], opacity: [0.4, 0.9, 0.4] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-full bg-emerald-500/25 blur-md pointer-events-none"
        />
      )}

      {/* OpenGits Panda Brand Silhouette Avatar */}
      <motion.svg
        viewBox="0 0 32 32"
        className="w-6 h-6 shrink-0 drop-shadow-xs"
        animate={
          isWarning
            ? { rotate: [0, -10, 10, -6, 6, 0], scale: [1, 1.05, 1] }
            : isThinking
            ? { scale: [1, 1.08, 1], y: [0, -1, 0] }
            : isSuccess
            ? { scale: [1, 1.15, 1], y: [0, -2, 0] }
            : { scale: 1, y: 0 }
        }
        transition={
          isWarning
            ? { duration: 0.6, repeat: Infinity, ease: "easeInOut" }
            : isThinking
            ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
            : isSuccess
            ? { duration: 0.8, repeat: 3, ease: "easeOut" }
            : { duration: 0.3 }
        }
      >
        {/* Layer 1: Solid Badge Circle */}
        <circle cx="16" cy="16" r="14" className="fill-theme-foreground" />

        {/* Layer 2: White Panda Head Base */}
        <circle cx="16" cy="17.2" r="8.2" className="fill-theme-bg" />

        {/* Layer 3: Iconic Black Panda Ears */}
        <circle cx="9.5" cy="11" r="2.8" className="fill-theme-foreground stroke-theme-bg" strokeWidth="0.9" />
        <circle cx="22.5" cy="11" r="2.8" className="fill-theme-foreground stroke-theme-bg" strokeWidth="0.9" />

        {/* Layer 4: Panda Eye Patches */}
        <ellipse cx="12.4" cy="16.2" rx="2.3" ry="2.8" transform="rotate(-15 12.4 16.2)" className="fill-theme-foreground" />
        <ellipse cx="19.6" cy="16.2" rx="2.3" ry="2.8" transform="rotate(15 19.6 16.2)" className="fill-theme-foreground" />

        {/* White Pupils / Sparkle Highlights */}
        <circle cx="12.7" cy="15.6" r="0.8" className="fill-theme-bg" />
        <circle cx="19.3" cy="15.6" r="0.8" className="fill-theme-bg" />

        {/* Layer 5: Black Panda Nose & Smile */}
        <ellipse cx="16" cy="19.0" rx="1.4" ry="1.0" className="fill-theme-foreground" />
        <path d="M14.2 20.4 Q16 21.6 17.8 20.4" className="stroke-theme-foreground" strokeWidth="1.1" strokeLinecap="round" fill="none" />
      </motion.svg>
    </motion.div>
  );
}
