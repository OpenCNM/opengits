import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FourPetalCloseIconProps extends React.SVGProps<SVGSVGElement> {
 className?: string;
}

/**
 * 🌸 FourPetalCloseIcon (古典修长四叶草关闭图标)
 * 独立全局 UI 组件，融合古典四叶草纹章与 X 关闭功能语义。
 * 具备 GPU 硬件加速 ([transform:translateZ(0)]) 与 60fps 弹簧贝塞尔曲线 (cubic-bezier) 丝滑悬停旋转。
 */
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
 {/* 45° 斜向修长大尺寸四叶草花瓣群 (Slender & Elongated Saltire Quatrefoil) */}
 <g transform="rotate(45 12 12)">
 {/* Top Petal -> Rotates to Northwest */}
 <path
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 {/* Right Petal -> Rotates to Northeast */}
 <path
 transform="rotate(90 12 12)"
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 {/* Bottom Petal -> Rotates to Southeast */}
 <path
 transform="rotate(180 12 12)"
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 {/* Left Petal -> Rotates to Southwest */}
 <path
 transform="rotate(270 12 12)"
 d="M12 10.5 C11.2 8.5, 9.6 5.8, 10.0 3.2 C10.3 2.0, 11.2 1.8, 12 3.2 C12.8 1.8, 13.7 2.0, 14.0 3.2 C14.4 5.8, 12.8 8.5, 12 10.5 Z"
 fill="currentColor"
 fillOpacity="0.15"
 />
 </g>
 {/* 徽章中心压印凝结点 */}
 <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
 </svg>
 );
}

/**
 * ⚡ ResponsiveCloseIcon (多主题响应式 Dialog 关闭图标)
 * 在 vercel (亮色) 与 dark (暗色) 模式下渲染现代极简 X 图标；
 * 在不同模式下渲染图标。
 */
export function ResponsiveCloseIcon({ className }: { className?: string }) {
 return (
 <>
 <X className={cn("size-4 text-theme-muted hover:text-theme-foreground transition-colors ", className)} />
 <FourPetalCloseIcon className={cn("size-6 hidden", className)} />
 </>
 );
}

export default FourPetalCloseIcon;
