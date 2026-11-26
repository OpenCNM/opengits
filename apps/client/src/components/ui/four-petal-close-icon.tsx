import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FourPetalCloseIconProps extends React.SVGProps<SVGSVGElement> {
 className?: string;
}

export function FourPetalCloseIcon({ className, ...props }: FourPetalCloseIconProps) {
 return (
 <svg
 viewBox="0 0 24 24"
 fill="none"
 stroke="currentColor"
 strokeWidth="1.6"
 strokeLinecap="round"
 strokeLinejoin="round"
 className={cn(
 "size-6 origin-center transition-transform duration-350 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:rotate-90 text-theme-primary group-hover:text-theme-accent will-change-transform [transform:translateZ(0)]",
 className,
 )}
 {...props}
 >
 <g transform="rotate(45 12 12)">
 <path
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 <path
 transform="rotate(90 12 12)"
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 <path
 transform="rotate(180 12 12)"
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 <path
 transform="rotate(270 12 12)"
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 </g>
 <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
 </svg>
 );
}

export function ResponsiveCloseIcon({ className }: { className?: string }) {
 return (
 <>
 <X className={cn("size-4 text-theme-muted hover:text-theme-foreground transition-colors ", className)} />
 <FourPetalCloseIcon className={cn("size-6 hidden", className)} />
 </>
 );
}

export default FourPetalCloseIcon;
