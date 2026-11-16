"use client";

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import type React from "react";
import { cn } from "@/lib/utils";

export const PreviewCard: typeof PreviewCardPrimitive.Root =
 PreviewCardPrimitive.Root;

export function PreviewCardTrigger({
 ...props
}: PreviewCardPrimitive.Trigger.Props): React.ReactElement {
 return (
 <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />
 );
}

export function PreviewCardPopup({
  className,
  children,
  align = "center",
  side = "top",
  sideOffset = 4,
  collisionPadding = 8,
  anchor,
  portalProps,
  positionerClassName,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  collisionPadding?: PreviewCardPrimitive.Positioner.Props["collisionPadding"];
  anchor?: PreviewCardPrimitive.Positioner.Props["anchor"];
  portalProps?: PreviewCardPrimitive.Portal.Props;
  positionerClassName?: string;
}): React.ReactElement {
  return (
    <PreviewCardPrimitive.Portal {...portalProps}>
      <PreviewCardPrimitive.Positioner
        align={align}
        side={side}
        anchor={anchor}
        className={cn("z-[250]", positionerClassName)}
        data-slot="preview-card-positioner"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
      >
 <PreviewCardPrimitive.Popup
 className={cn(
 "relative flex flex-col w-64 origin-(--transform-origin) rounded-xl border border-theme-border bg-theme-surface p-4 text-theme-foreground text-sm shadow-xl transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
 className,
 )}
 data-slot="preview-card-content"
 {...props}
 >
 {children}
 </PreviewCardPrimitive.Popup>
 </PreviewCardPrimitive.Positioner>
 </PreviewCardPrimitive.Portal>
 );
}

export {
 PreviewCardPrimitive,
 PreviewCard as HoverCard,
 PreviewCardTrigger as HoverCardTrigger,
 PreviewCardPopup as HoverCardContent,
};
