"use client";

import React, { useState, useEffect } from 'react';
import { ExternalLink, Video } from 'lucide-react';
import * as m from '@/paraglide/messages';

export default function YouTube({ id, title }: { id: string; title?: string }) {
 const [showTip, setShowTip] = useState(false);

 useEffect(() => {
 let isMounted = true;
 const timer = setTimeout(() => {
 if (isMounted) setShowTip(true);
 }, 3000);

 const img = new Image();
 img.src = `https://img.youtube.com/vi/${id}/mqdefault.jpg`;

 img.onload = () => {
 if (isMounted) {
 clearTimeout(timer);
 setShowTip(false);
 }
 };

 img.onerror = () => {
 if (isMounted) {
 clearTimeout(timer);
 setShowTip(true);
 }
 };

 return () => {
 isMounted = false;
 clearTimeout(timer);
 };
 }, [id]);

 const watchUrl = `https://www.youtube.com/watch?v=${id}`;
 const embedUrl = `https://www.youtube.com/embed/${id}`;
 const bilibiliSearchUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(title || id)}`;

 return (
 <div className="my-8 flex flex-col gap-3">
 <div className="aspect-video w-full overflow-hidden rounded-xl border border-theme-border/60 bg-theme-bg shadow-sm relative">
 <iframe
 className="h-full w-full relative z-10"
 src={embedUrl}
 title={title || m.youtube_player_title()}
 frameBorder="0"
 allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
 allowFullScreen
 {...({ credentialless: "true" } as any)}
 ></iframe>
 </div>

 {showTip && (
 <div className="p-3.5 bg-theme-bg border border-theme-border/60 rounded-xl text-theme-muted font-sans flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-[0_2px_8px_rgba(0,0,0,0.02)] animate-in fade-in slide-in-from-top-2 duration-500">
 <div className="flex items-start gap-2.5 min-w-0">
 <Video size={16} className="text-theme-primary shrink-0 mt-0.5" />
 <div className="text-xs leading-normal">
 <span className="font-serif font-bold text-theme-foreground ">{m.youtube_tip_title()}</span>
 {m.youtube_tip_desc()}
 </div>
 </div>

 <div className="flex items-center gap-3 shrink-0 text-caption font-medium border-t sm:border-t-0 pt-2.5 sm:pt-0 border-theme-border/50">
 <a
 href={watchUrl}
 target="_blank"
 rel="noopener noreferrer"
 className="flex items-center gap-1 text-theme-primary hover:text-theme-primary transition-colors font-semibold"
 >
 <span>YouTube</span>
 <ExternalLink size={10} />
 </a>
 <span className="text-theme-muted">|</span>
 <a
 href={bilibiliSearchUrl}
 target="_blank"
 rel="noopener noreferrer"
 className="flex items-center gap-1 text-theme-muted hover:text-theme-foreground transition-colors font-semibold"
 >
 <span>{m.youtube_bilibili_search()}</span>
 </a>
 </div>
 </div>
 )}
 </div>
 );
}
