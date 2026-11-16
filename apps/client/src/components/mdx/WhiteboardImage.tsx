'use client';

import React, { useState, useEffect } from 'react';
import { Image as ImageIcon, ZoomIn } from 'lucide-react';
import * as m from '@/paraglide/messages';
import MediaLightboxModal from './MediaLightboxModal';

export default function WhiteboardImage({
  src,
  alt,
  caption,
  crossOrigin,
  ...props
}: {
  src: string;
  alt?: string;
  caption?: string;
  crossOrigin?: string;
  [key: string]: any;
}) {
  const [isLightImage, setIsLightImage] = useState<boolean | null>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const spanRef = React.useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!src || typeof window === 'undefined') return;

    // 跨域外链图片（若无显式 CORS 授权）无法供 Canvas 读取像素（Tainted Canvas），直接安全跳过离屏探测
    const isCrossOrigin = /^https?:\/\//i.test(src) && !src.startsWith(window.location.origin);
    if (isCrossOrigin && !crossOrigin) {
      setIsLightImage(false);
      return;
    }

    let isMounted = true;

    const probeLuminance = () => {
      if (!isMounted) return;
      const img = new Image();
      if (crossOrigin) {
        img.crossOrigin = crossOrigin;
      }
      img.src = src;

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          ctx.drawImage(img, 0, 0, 16, 16);
          const imageData = ctx.getImageData(0, 0, 16, 16);
          const data = imageData.data;

          let totalLuminance = 0;
          let count = 0;

          for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha < 50) continue; // Skip fully transparent background pixels

            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // ITU-R BT.601 relative luminance formula
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            totalLuminance += lum;
            count++;
          }

          if (count > 0 && isMounted) {
            const avgLuminance = totalLuminance / count;
            // Average luminance > 175 indicates a white-background or bright image
            setIsLightImage(avgLuminance > 175);
          }
        } catch {
          // Fallback for CORS or Canvas read errors
          if (isMounted) setIsLightImage(false);
        }
      };

      img.onerror = () => {
        if (isMounted) setIsLightImage(false);
      };
    };

    // 视口门控（性能修复 2026-10-13）：同源图的离屏探测会无视口提前抓取图片
    // （渲染 img 之外多解码一份）——改为进入视口后才探测；晚探测的代价仅为
    // 暗色模式亮度微调延迟出现。不支持 IntersectionObserver 的环境立即探测。
    const target = spanRef.current;
    if (typeof IntersectionObserver === 'undefined' || !target) {
      probeLuminance();
      return () => {
        isMounted = false;
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            probeLuminance();
            break;
          }
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(target);

    return () => {
      isMounted = false;
      observer.disconnect();
    };
  }, [src, crossOrigin]);

  return (
    <>
      <span ref={spanRef} className="block my-6 relative group/img">
        <span
          onClick={() => setIsLightboxOpen(true)}
          title={m.diagram_click_to_zoom()}
          className={`block overflow-hidden rounded-xl border border-theme-border bg-theme-bg relative shadow-sm transition-all duration-300 cursor-zoom-in ${
            isLightImage
              ? 'dark:brightness-90 dark:contrast-[0.98] dark:hover:brightness-100 dark:border-white/15 dark:shadow-md'
              : ''
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt || 'Image'}
            loading="lazy"
            decoding="async"
            className="w-full h-auto object-cover block transition-all duration-300 group-hover/img:scale-[1.01]"
            {...props}
          />

          {/* 悬停放大镜浮标 */}
          <span className="absolute top-3 right-3 p-1.5 rounded-lg bg-theme-bg/80 border border-theme-border/80 backdrop-blur-md opacity-0 group-hover/img:opacity-100 transition-opacity duration-200 shadow-sm pointer-events-none text-theme-foreground">
            <ZoomIn className="w-3.5 h-3.5 text-theme-muted" />
          </span>
        </span>

        {caption && (
          <span className="block text-center text-xs text-theme-muted mt-3 flex items-center justify-center gap-1.5 font-sans select-none">
            <ImageIcon size={12} className="text-theme-muted" /> {caption}
          </span>
        )}
      </span>

      {/* 图片全屏平移缩放灯箱 */}
      <MediaLightboxModal
        isOpen={isLightboxOpen}
        onClose={() => setIsLightboxOpen(false)}
        imageSrc={src}
        alt={alt || caption || 'Image'}
        title={caption || alt}
      />
    </>
  );
}
