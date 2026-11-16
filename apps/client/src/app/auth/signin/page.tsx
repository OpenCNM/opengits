"use client";
import * as m from '@/paraglide/messages';

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function SignInContent() {
 const searchParams = useSearchParams();
 const callbackUrl = searchParams.get("callbackUrl") || "/";
 const error = searchParams.get("error");
 const isActualError = error && error !== "SessionRequired";

 const [mounted, setMounted] = useState(false);
 useEffect(() => {
 const timer = setTimeout(() => setMounted(true), 10);
 return () => clearTimeout(timer);
 }, []);

 return (
 <div className={`relative z-10 w-full max-w-[320px] transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
 
 {/* Minimal Glass Card */}
 <div className="relative overflow-hidden rounded-[1.5rem] bg-theme-surface/90 backdrop-blur-2xl border border-theme-border shadow-xl shadow-black/10 p-8">
 
 <div className="absolute inset-0 bg-[url('/noise.svg')] opacity-[0.02] mix-blend-overlay pointer-events-none"></div>

 <div className="relative z-10 flex flex-col items-center">
 
 {/* Very minimal header */}
 <h2 className="text-xl font-medium tracking-tight text-theme-foreground mb-8 font-sans">
 {m.common_signin()}
 </h2>

 {isActualError && (
 <div className="w-full mb-6 p-3 rounded-xl bg-theme-accent/10 border border-theme-accent/30 text-theme-accent text-xs text-center font-medium">
 {m.auth_signin_failed()}
 </div>
 )}

          <div className="w-full flex flex-col gap-3">
            <button
              onClick={() => signIn("github", { callbackUrl })}
              className="group w-full flex items-center justify-center gap-3 px-5 py-3.5 bg-theme-primary text-theme-primary-fg rounded-xl font-medium transition-all duration-300 hover:scale-[1.02] hover:opacity-90 hover:shadow-lg hover:shadow-black/10 active:scale-[0.98] cursor-pointer"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] transition-transform group-hover:rotate-6">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
              </svg>
              <span className="text-xs tracking-wide">{m.auth_login_with_github()}</span>
            </button>
          </div>
 </div>
 </div>
 </div>
 );
}

export default function SignInPage() {
 return (
 <div className="relative min-h-screen flex items-center justify-center bg-theme-bg p-4 sm:p-8 overflow-hidden font-sans">
      {/* lint-ignore: HEX-001 */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_50%,#000_70%,transparent_100%)]"></div>
 
 <Suspense fallback={null}>
 <SignInContent />
 </Suspense>
 </div>
 );
}
