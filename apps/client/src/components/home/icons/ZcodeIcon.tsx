export function ZcodeIcon({ className = "w-16 h-16" }: { className?: string }) {
  return (
    <div className={`${className} relative flex items-center justify-center rounded-2xl bg-gradient-to-b from-black to-zinc-900 text-white shadow-xl/20 border border-white/20 shrink-0`}>
      <svg 
        xmlns="http://www.w3.org/2000/svg" 
        fill="none" 
        viewBox="0 0 256 218" 
        className="w-[55%] h-auto shrink-0 text-current drop-shadow-md" 
        aria-hidden="true" 
        focusable="false"
      >
        <path fill="currentColor" d="M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z"></path>
        <path fill="currentColor" d="M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z"></path>
        <path fill="currentColor" d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z"></path>
      </svg>
    </div>
  );
}
