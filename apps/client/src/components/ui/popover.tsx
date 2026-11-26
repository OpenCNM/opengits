"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type React from "react";
import { cn } from "@/lib/utils";

export const PopoverCreateHandle: typeof PopoverPrimitive.createHandle =
 PopoverPrimitive.createHandle;

export const Popover: typeof PopoverPrimitive.Root = PopoverPrimitive.Root;

export function PopoverTrigger({
 className,
 children,
 ...props
}: PopoverPrimitive.Trigger.Props): React.ReactElement {
 return (
 <PopoverPrimitive.Trigger
 className={className}
 data-slot="popover-trigger"
 {...props}
 >
 {children}
 </PopoverPrimitive.Trigger>
 );
}

export function PopoverPopup({
  children,
  className,
  viewportClassName,
  positionerClassName,
  side = "top",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  collisionPadding = 8,
  tooltipStyle = false,
  anchor,
  portalProps,
  ...props
}: PopoverPrimitive.Popup.Props & {
 portalProps?: PopoverPrimitive.Portal.Props;
 side?: PopoverPrimitive.Positioner.Props["side"];
 align?: PopoverPrimitive.Positioner.Props["align"];
 sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
 alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
 collisionPadding?: PopoverPrimitive.Positioner.Props["collisionPadding"];
 tooltipStyle?: boolean;
 anchor?: PopoverPrimitive.Positioner.Props["anchor"];
 viewportClassName?: string;
 positionerClassName?: string;
}): React.ReactElement {
 return (
 <PopoverPrimitive.Portal {...portalProps}>
 <PopoverPrimitive.Positioner
 align={align}
 alignOffset={alignOffset}
 anchor={anchor}
 className={cn(
 "z-[250] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
 positionerClassName,
 )}
 data-slot="popover-positioner"
 side={side}
 sideOffset={sideOffset}
 collisionPadding={collisionPadding}
 >
 <PopoverPrimitive.Popup
 className={cn(
 "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-xl border border-theme-border bg-theme-surface text-theme-foreground shadow-xl outline-none transition-[width,height,scale,opacity] data-starting-style:scale-98 data-starting-style:opacity-0 z-[250]",
 tooltipStyle &&
 "w-fit text-balance rounded-md text-xs shadow-md/5",
 className,
 )}
 data-slot="popover-popup"
 {...props}
 >
 <PopoverPrimitive.Viewport
 className={cn(
 "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-3 [--viewport-inline-padding:1rem] has-data-[slot=calendar]:p-0 data-instant:transition-none",
 tooltipStyle
 ? "py-1 [--viewport-inline-padding:0.5rem]"
 : "not-data-transitioning:overflow-y-auto",
 viewportClassName,
 )}
 data-slot="popover-viewport"
 >
 {children}
 </PopoverPrimitive.Viewport>
 </PopoverPrimitive.Popup>
 </PopoverPrimitive.Positioner>
 </PopoverPrimitive.Portal>
 );
}

export function PopoverClose({
 ...props
}: PopoverPrimitive.Close.Props): React.ReactElement {
 return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export function PopoverTitle({
 className,
 ...props
}: PopoverPrimitive.Title.Props): React.ReactElement {
 return (
 <PopoverPrimitive.Title
 className={cn("font-semibold text-lg leading-none", className)}
 data-slot="popover-title"
 {...props}
 />
 );
}

export function PopoverDescription({
 className,
 ...props
}: PopoverPrimitive.Description.Props): React.ReactElement {
 return (
 <PopoverPrimitive.Description
 className={cn("text-muted-foreground text-sm", className)}
 data-slot="popover-description"
 {...props}
 />
 );
}

export { PopoverPrimitive, PopoverPopup as PopoverContent };
