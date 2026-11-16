'use client';

import React from 'react';
import Link from 'next/link';
import {
  BookOpen,
  Code,
  Terminal,
  Zap,
  FileText,
  Settings,
  Rocket,
  Cpu,
  Layers,
  HelpCircle,
  Star,
  Compass,
  Database,
  Globe,
  Lock,
  Shield,
  CheckCircle,
  AlertCircle,
  Info,
  Sparkles,
  Folder,
  GitBranch,
  ArrowRight,
  Play,
  ExternalLink,
  LucideIcon,
} from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  book: BookOpen,
  bookopen: BookOpen,
  code: Code,
  terminal: Terminal,
  zap: Zap,
  filetext: FileText,
  document: FileText,
  settings: Settings,
  rocket: Rocket,
  cpu: Cpu,
  layers: Layers,
  star: Star,
  compass: Compass,
  database: Database,
  globe: Globe,
  lock: Lock,
  shield: Shield,
  check: CheckCircle,
  checkcircle: CheckCircle,
  alert: AlertCircle,
  alertcircle: AlertCircle,
  info: Info,
  sparkles: Sparkles,
  folder: Folder,
  gitbranch: GitBranch,
  arrowright: ArrowRight,
  play: Play,
  externallink: ExternalLink,
  help: HelpCircle,
  helpcircle: HelpCircle,
};

interface CardGroupProps {
  cols?: number | string;
  children: React.ReactNode;
}

export function CardGroup({ cols = 2, children }: CardGroupProps) {
  const parsedCols = typeof cols === 'string' ? Number(cols.trim()) : cols;
  const normalizedCols =
    parsedCols === 1 || parsedCols === 2 || parsedCols === 3 || parsedCols === 4
      ? parsedCols
      : 2;

  const gridColsClass =
    normalizedCols === 1 ? 'grid-cols-1' :
    normalizedCols === 2 ? 'grid-cols-1 md:grid-cols-2' :
    normalizedCols === 3 ? 'grid-cols-1 md:grid-cols-3' :
    'grid-cols-1 md:grid-cols-2 lg:grid-cols-4';

  return (
    <div data-card-cols={normalizedCols} className={`grid gap-4 my-6 ${gridColsClass}`}>
      {children}
    </div>
  );
}

interface CardProps {
  title: string;
  icon?: string;
  href?: string;
  eyebrow?: string;
  children?: React.ReactNode;
  description?: string;
}

export function Card({ title, icon, href, eyebrow, children, description }: CardProps) {
  const getIconComponent = (iconName?: string): LucideIcon | null => {
    if (!iconName) return null;
    const normalized = iconName.toLowerCase().replace(/[-_]/g, '');
    return ICON_MAP[normalized] || Layers;
  };

  const IconComp = getIconComponent(icon);
  const isHttpExternal = Boolean(href && /^(?:https?:)?\/\//i.test(href));
  const isProtocolLink = Boolean(href && /^(?:mailto|tel):/i.test(href));

  const cardContent = (
    <div className="p-5 rounded-2xl border border-theme-border bg-theme-bg/50 backdrop-blur-md transition-all duration-300 hover:border-theme-primary/30 hover:shadow-md hover:-translate-y-0.5 group relative overflow-hidden flex flex-col h-full">
      <div className="flex items-start gap-4">
        {IconComp && (
          <div className="p-2 rounded-xl bg-theme-primary/10 text-theme-primary group-hover:bg-theme-primary/10 transition-colors shrink-0">
            <IconComp size={18} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          {eyebrow && (
            <div className="text-xs font-medium text-theme-muted mb-1">
              {eyebrow}
            </div>
          )}
          <div className="flex items-start justify-between gap-2 mb-1">
            <h4 className="text-sm font-semibold text-theme-foreground m-0 leading-snug break-words group-hover:text-theme-primary transition-colors">
              {title}
            </h4>
            {isHttpExternal && (
              <ExternalLink
                size={13}
                aria-hidden="true"
                className="shrink-0 mt-0.5 text-theme-muted/70 group-hover:text-theme-primary transition-colors"
              />
            )}
          </div>
          {description && (
            <p className="text-xs text-theme-muted leading-relaxed m-0">
              {description}
            </p>
          )}
          {children && (
            <div className="text-xs text-theme-muted leading-relaxed space-y-2 [&>p]:m-0 mt-0.5 [&_code]:text-theme-foreground [&_code]:bg-theme-surface [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:border [&_code]:border-theme-border/60 [&_code]:font-normal">
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (href) {
    if (isHttpExternal) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="no-underline block h-full"
        >
          {cardContent}
        </a>
      );
    }
    if (isProtocolLink) {
      return (
        <a href={href} className="no-underline block h-full">
          {cardContent}
        </a>
      );
    }
    return (
      <Link href={href} className="no-underline block h-full">
        {cardContent}
      </Link>
    );
  }

  return <div className="h-full">{cardContent}</div>;
}
