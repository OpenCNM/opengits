import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
 "theme-primary grid w-full items-start gap-x-2 gap-y-0.5 text-sm has-[>svg]:has-data-[slot=alert-action]:grid-cols-[calc(var(--spacing)*4)_1fr_auto] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-[>svg]:gap-x-2 [&>svg]:h-lh [&>svg]:w-4",
 {
 defaultVariants: {
 variant: "default",
 },
 variants: {
 variant: {
 default:
 "[&>svg]:text-theme-muted border-l-theme-border",
 error:
 "border-l-theme-accent [&>svg]:text-theme-accent",
 info: "border-l-sky-700 [&>svg]:text-sky-700",
 success: "border-l-emerald-700 [&>svg]:text-emerald-700",
 warning: "border-l-theme-primary [&>svg]:text-theme-primary",
 },
 },
 },
);

export function Alert({
 className,
 variant,
 ...props
}: React.ComponentProps<"div"> &
 VariantProps<typeof alertVariants>): React.ReactElement {
 return (
 <div
 className={cn(alertVariants({ variant }), className)}
 data-slot="alert"
 role="alert"
 {...props}
 />
 );
}

export function AlertTitle({
 className,
 ...props
}: React.ComponentProps<"div">): React.ReactElement {
 return (
 <div
 className={cn("font-medium [svg~&]:col-start-2", className)}
 data-slot="alert-title"
 {...props}
 />
 );
}

export function AlertDescription({
 className,
 ...props
}: React.ComponentProps<"div">): React.ReactElement {
 return (
 <div
 className={cn(
 "flex flex-col gap-2.5 text-muted-foreground [svg~&]:col-start-2",
 className,
 )}
 data-slot="alert-description"
 {...props}
 />
 );
}

export function AlertAction({
 className,
 ...props
}: React.ComponentProps<"div">): React.ReactElement {
 return (
 <div
 className={cn(
 "flex gap-1 max-sm:col-start-2 max-sm:mt-2 sm:row-start-1 sm:row-end-3 sm:self-center sm:[[data-slot=alert-description]~&]:col-start-2 sm:[[data-slot=alert-title]~&]:col-start-2 sm:[svg~&]:col-start-2 sm:[svg~[data-slot=alert-description]~&]:col-start-3 sm:[svg~[data-slot=alert-title]~&]:col-start-3",
 className,
 )}
 data-slot="alert-action"
 {...props}
 />
 );
}
