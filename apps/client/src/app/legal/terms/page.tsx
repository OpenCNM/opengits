import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import * as m from '@/paraglide/messages';

export function generateMetadata() {
  return { title: m.legal_terms_page_title() };
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-theme-bg text-theme-foreground font-sans">
      <div className="mx-auto max-w-3xl px-4 py-12">
        <Link href="/" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-serif text-theme-foreground border border-theme-border/60 hover:border-theme-primary hover:text-theme-primary transition-colors">
          <ArrowLeft size={14} />
          <span>{m.account_back_to_bookshelf()}</span>
        </Link>

        <h1 className="mt-8 font-serif text-3xl font-bold">{m.footer_terms()}</h1>
        <p className="mt-2 text-xs text-theme-muted">{m.legal_terms_last_updated()}</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-theme-foreground/90">
          <section>
            <h2 className="font-serif text-lg font-bold mb-2">{m.legal_terms_sec1_title()}</h2>
            <p>{m.legal_terms_sec1_desc()}</p>
          </section>
          <section>
            <h2 className="font-serif text-lg font-bold mb-2">{m.legal_terms_sec2_title()}</h2>
            <p>{m.legal_terms_sec2_desc()}</p>
          </section>
          <section>
            <h2 className="font-serif text-lg font-bold mb-2">{m.legal_terms_sec3_title()}</h2>
            <p>{m.legal_terms_sec3_desc()}</p>
          </section>
          <section>
            <h2 className="font-serif text-lg font-bold mb-2">{m.legal_terms_sec4_title()}</h2>
            <p>{m.legal_terms_sec4_desc()}</p>
          </section>
          <section>
            <h2 className="font-serif text-lg font-bold mb-2">{m.legal_terms_sec5_title()}</h2>
            <p>{m.legal_terms_sec5_desc()}</p>
          </section>
          <section>
            <h2 className="font-serif text-lg font-bold mb-2">{m.legal_terms_sec6_title()}</h2>
            <p>{m.legal_terms_sec6_desc()}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
