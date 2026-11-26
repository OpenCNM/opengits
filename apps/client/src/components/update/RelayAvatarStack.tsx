'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';

export interface RelayParticipant {
  userId: string;
  name: string | null;
  image: string | null;
  active: boolean;
}

const DEFAULT_MAX_VISIBLE = 5;

export function RelayAvatarStack({
  participants,
  size = 'sm',
  maxVisible = DEFAULT_MAX_VISIBLE,
}: {
  participants: RelayParticipant[];
  size?: 'xs' | 'sm';
  maxVisible?: number;
}) {
  if (participants.length === 0) return null;
  const visible = participants.slice(0, maxVisible);
  const overflow = participants.length - visible.length;
  const px = size === 'xs' ? 'size-5 text-micro' : 'size-6 text-micro';

  return (
    <div className="flex items-center -space-x-1.5 select-none" title={m.relay_participants_count({ count: participants.length })}>
      {visible.map((p) => (
        <div key={p.userId} className="relative inline-flex shrink-0">
          <Avatar
            title={p.name ?? m.relay_participant()}
            className={cn(
              px,
              'relative rounded-full ring-2 ring-theme-bg shadow-2xs'
            )}
          >
            <AvatarImage src={p.image ?? ''} alt={p.name ?? m.relay_participant()} />
            <AvatarFallback className="bg-theme-primary text-theme-primary-fg font-sans font-bold">
              {(p.name ?? '?').slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          {p.active && (
            <span
              className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-1 ring-theme-bg animate-pulse pointer-events-none"
              title={m.relay_transcribing()}
            />
          )}
        </div>
      ))}
      {overflow > 0 && (
        <span
          className={cn(
            px,
            'inline-flex items-center justify-center rounded-full bg-theme-surface border border-theme-border text-theme-muted font-mono font-bold ring-2 ring-theme-bg shadow-2xs'
          )}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
