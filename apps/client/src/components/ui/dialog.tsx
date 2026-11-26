"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { XIcon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";
import * as m from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FourPetalCloseIcon, ResponsiveCloseIcon } from "@/components/ui/four-petal-close-icon";

export { FourPetalCloseIcon, ResponsiveCloseIcon };

export const DialogCreateHandle: typeof DialogPrimitive.createHandle =
 DialogPrimitive.createHandle;

export const Dialog: typeof DialogPrimitive.Root = DialogPrimitive.Root;

export const DialogPortal: typeof DialogPrimitive.Portal =
 DialogPrimitive.Portal;

export function DialogTrigger(
 props: DialogPrimitive.Trigger.Props,
): React.ReactElement {
 return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogClose(
 props: DialogPrimitive.Close.Props,
): React.ReactElement {
 return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export function DialogBackdrop({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

export function DialogViewport({
  className,
  ...props
}: DialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-4 md:p-6 overflow-y-auto",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

export function DialogPopup({
  className,
  children,
  showCloseButton = true,
  showCornerFlourishes = true,
  showInnerBorder = false,
  bottomStickOnMobile = true,
  closeProps,
  portalProps,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  showCornerFlourishes?: boolean;
  showInnerBorder?: boolean;
  bottomStickOnMobile?: boolean;
  closeProps?: DialogPrimitive.Close.Props;
  portalProps?: DialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <DialogPortal {...portalProps}>
      <DialogBackdrop />
      <DialogViewport
        className={cn(
          bottomStickOnMobile &&
            "max-sm:p-0 max-sm:items-end",
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            "relative flex max-h-[92vh] min-h-0 w-full min-w-0 max-w-lg origin-center flex-col rounded-2xl border border-theme-border bg-theme-bg text-theme-foreground opacity-[calc(1-var(--nested-dialogs))] shadow-2xl outline-none transition-[scale,opacity] duration-150 ease-out will-change-transform data-ending-style:opacity-0 data-starting-style:opacity-0 sm:scale-[calc(1-0.1*var(--nested-dialogs))] sm:data-ending-style:scale-95 sm:data-starting-style:scale-95 overflow-hidden",
            showInnerBorder && "before:pointer-events-none before:absolute before:inset-1.5 before:rounded-[calc(var(--radius-2xl)-6px)] before:border before:border-theme-primary/60",
            bottomStickOnMobile &&
              "max-sm:max-w-none max-sm:origin-bottom max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4 max-sm:before:hidden max-sm:before:rounded-none",
            className,
          )}
          data-slot="dialog-popup"
          {...props}
        >

 {showCornerFlourishes && (
 <div className="hidden pointer-events-none select-none">
 <div className="absolute top-3.5 left-3.5 text-theme-primary/50 font-serif text-sm z-30">⌜</div>
 <div className="absolute bottom-3.5 right-3.5 text-theme-primary/50 font-serif text-sm z-30">⌟</div>
 </div>
 )}

 {children}

 {showCloseButton && (
 <DialogPrimitive.Close
 aria-label={m.common_close()}
 className="absolute end-3 top-3 z-20 group focus:outline-none focus-visible:outline-none"
 render={
 <Button
 size="icon"
 variant="ghost"
 className="rounded-full bg-transparent border border-transparent text-theme-primary/80 hover:text-theme-accent hover:bg-theme-surface/90 hover:border-theme-border/80 hover:shadow-xs focus:outline-none focus:ring-0 focus:border-transparent focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-transparent cursor-pointer transition-[background-color,border-color,color,box-shadow] duration-350 ease-[cubic-bezier(0.16,1,0.3,1)] flex items-center justify-center p-1.5"
 />
 }
 {...closeProps}
 >
 <ResponsiveCloseIcon />
 </DialogPrimitive.Close>
 )}
 </DialogPrimitive.Popup>
 </DialogViewport>
 </DialogPortal>
 );
}

export function DialogHeader({
 className,
 render,
 ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
 const defaultProps = {
 className: cn(
 "flex flex-col gap-1.5 p-6 border-b border-theme-border/40 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-4 max-sm:pb-4 font-heading",
 className,
 ),
 "data-slot": "dialog-header",
 };

 return useRender({
 defaultTagName: "div",
 props: mergeProps<"div">(defaultProps, props),
 render,
 });
}

export function DialogFooter({
 className,
 variant = "default",
 render,
 ...props
}: useRender.ComponentProps<"div"> & {
 variant?: "default" | "bare";
}): React.ReactElement {
 const defaultProps = {
 className: cn(
 "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)] font-sans",
 variant === "default" && "border-t border-theme-border/40 bg-theme-surface/40 py-4",
 variant === "bare" &&
 "in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pt-3 pt-4 pb-6",
 className,
 ),
 "data-slot": "dialog-footer",
 };

 return useRender({
 defaultTagName: "div",
 props: mergeProps<"div">(defaultProps, props),
 render,
 });
}

export function DialogTitle({
 className,
 ...props
}: DialogPrimitive.Title.Props): React.ReactElement {
 return (
 <DialogPrimitive.Title
 className={cn(
 "font-heading font-medium text-xl md:text-2xl text-theme-foreground leading-snug tracking-wider",
 className,
 )}
 data-slot="dialog-title"
 {...props}
 />
 );
}

export function DialogDescription({
 className,
 ...props
}: DialogPrimitive.Description.Props): React.ReactElement {
 return (
 <DialogPrimitive.Description
 className={cn("font-sans text-theme-muted text-xs md:text-sm leading-relaxed", className)}
 data-slot="dialog-description"
 {...props}
 />
 );
}

export function DialogPanel({
 className,
 scrollFade = true,
 render,
 ...props
}: useRender.ComponentProps<"div"> & {
 scrollFade?: boolean;
}): React.ReactElement {
 const defaultProps = {
 className: cn(
 "p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-4 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-2",
 className,
 ),
 "data-slot": "dialog-panel",
 };

 return (
 <ScrollArea scrollFade={scrollFade}>
 {useRender({
 defaultTagName: "div",
 props: mergeProps<"div">(defaultProps, props),
 render,
 })}
 </ScrollArea>
 );
}

export {
 DialogPrimitive,
 DialogBackdrop as DialogOverlay,
 DialogPopup as DialogContent,
};
