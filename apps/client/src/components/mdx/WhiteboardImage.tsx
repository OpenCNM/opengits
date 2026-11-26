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
            if (alpha < 50) continue;

            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            totalLuminance += lum;
            count++;
          }

          if (count > 0 && isMounted) {
            const avgLuminance = totalLuminance / count;
            setIsLightImage(avgLuminance > 175);
          }
        } catch {
          if (isMounted) setIsLightImage(false);
        }
      };

      img.onerror = () => {
        if (isMounted) setIsLightImage(false);
      };
    };

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
