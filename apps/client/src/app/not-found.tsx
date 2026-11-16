import Link from 'next/link';
import * as m from '@/paraglide/messages';
import { OpenGitsOctocatLogo } from '@/components/home/components/OpenGitsOctocatLogo';

export default function NotFound() {
  return (
    <main className="min-h-[70vh] flex flex-col items-center justify-center px-4 py-16 text-center font-sans">
      <div className="flex items-center justify-center mb-6">
        <OpenGitsOctocatLogo className="w-16 h-16 text-theme-primary/80" />
      </div>
      <h1 className="text-2xl font-bold font-serif text-theme-foreground tracking-tight sm:text-3xl mb-3">
        {m.not_found_title()}
      </h1>
      <p className="text-sm text-theme-muted max-w-md mb-8 leading-relaxed">
        {m.not_found_desc()}
      </p>
      <Link
        href="/"
        className="px-5 py-2.5 rounded-xl bg-theme-primary text-theme-primary-fg font-serif font-bold text-sm hover:opacity-90 transition-opacity shadow-sm"
      >
        {m.not_found_back_home()}
      </Link>
    </main>
  );
}