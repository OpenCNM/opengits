'use client';

import React, { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import { McpFlowShowcase } from './McpFlowShowcase';

interface AgentDemoShowcaseProps {
  customRepoUrl?: string;
}

export function AgentDemoShowcase({ customRepoUrl }: AgentDemoShowcaseProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Track the scroll progress of this container relative to the viewport
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start end", "start 55%"]
  });

  // 🚀 Silky 3D Perspective Rising & Leveling-Out Animation
  const scale = useTransform(scrollYProgress, [0, 1], [0.93, 1]);
  const opacity = useTransform(scrollYProgress, [0, 0.35, 1], [0.75, 0.95, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [36, 0]);
  const rotateX = useTransform(scrollYProgress, [0, 1], [4, 0]);

  return (
    <div ref={containerRef} id="cinematic-agent-demo-stage" className="w-full relative [perspective:1400px]">
      <motion.div 
        style={{ scale, opacity, y, rotateX }}
        className="transform-gpu origin-top will-change-transform"
      >
        <McpFlowShowcase />
      </motion.div>
    </div>
  );
}
