import { Loader2Icon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";
import * as m from "@/paraglide/messages";

export function Spinner({
 className,
 ...props
}: React.ComponentProps<typeof Loader2Icon>): React.ReactElement {
 return (
 <Loader2Icon
 aria-label={m.common_loading()}
 className={cn("animate-spin", className)}
 role="status"
 {...props}
 />
 );
}
