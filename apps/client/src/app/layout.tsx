import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { I18nProvider } from "fumadocs-ui/contexts/i18n";
import { AsyncLocalStorage } from "node:async_hooks";
import { overwriteServerAsyncLocalStorage, getServerAsyncLocalStorage } from "@/paraglide/runtime.js";

// Ensure Paraglide Server AsyncLocalStorage is globally registered for SSR
let serverStorage = getServerAsyncLocalStorage();
if (!serverStorage) {
  serverStorage = new AsyncLocalStorage();
  overwriteServerAsyncLocalStorage(serverStorage);
}

const geistSans = Geist({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: "OpenGits — AI-Ready Knowledge Hub for Open Source",
  description: "One-click: GitHub Repo → Beautiful Docs for Humans + Precise MCP Server & llms.txt for AI Agents",
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
    apple: '/apple-icon.png',
  },
};

import AuthProvider from '@/components/providers/AuthProvider';
import SelectionMenu from '@/components/selection/SelectionMenu';
import PreferencesModal from '@/components/PreferencesModal';
import OnboardingWizardModal from '@/components/OnboardingWizardModal';
import CustomSearchDialog from '@/components/SearchDialog';
import { UnifiedTaskDock } from '@/components/dock/UnifiedTaskDock';
import { ImportWizardProvider, ImportWizardModal } from '@/components/ImportWizard';
import { cn } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/constants";
import { resolveFontSize } from "@/lib/font-size";
import { ToastProvider } from "@/components/ui/toast";
import FontSizeProvider from "@/components/providers/FontSizeProvider";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { ThemeInitializer } from "@/components/providers/ThemeProvider";
import { getFumadocsTranslations } from "@/lib/i18n/fumadocs-i18n";

import { cookies } from 'next/headers';

export default async function RootLayout({
  children,
  modal,
}: Readonly<{
  children: React.ReactNode;
  modal: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const rawLocale = cookieStore.get('PARAGLIDE_LOCALE')?.value || cookieStore.get('NEXT_LOCALE')?.value || 'en';
  const locale = ['en', 'zh-CN'].includes(rawLocale) ? rawLocale : 'en';

  // 阅读字号：cookie → html class 由 SSR 直出，根字号首帧即最终值（rem 布局无水合跳动）
  const fontSize = resolveFontSize(cookieStore.get(STORAGE_KEYS.FONT_SIZE_COOKIE)?.value);

  // Inject into AsyncLocalStorage for SSR translation resolution across all Server & SSR Components
  if (serverStorage) {
    (serverStorage as any).enterWith({ locale });
  }

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={cn(geistSans.variable, geistMono.variable, `font-size-${fontSize}`)}
    >
      <head />

      <body
        className="font-sans antialiased selection:bg-theme-primary/10 selection:text-theme-primary"
        suppressHydrationWarning
      >
        <LocaleProvider initialLocale={locale}>
          <AuthProvider>
            <ToastProvider position="bottom-right">
              <ImportWizardProvider>
                <RootProvider 
                  theme={{ enabled: false }}
                  search={{ SearchDialog: CustomSearchDialog }}
                >
                  <I18nProvider translations={getFumadocsTranslations()}>
                    {children}
                    {modal}
                  </I18nProvider>
                </RootProvider>
                <SelectionMenu />
                <PreferencesModal />
                <OnboardingWizardModal />
                <ImportWizardModal />
                <UnifiedTaskDock />
                <FontSizeProvider />
                <ThemeInitializer />
              </ImportWizardProvider>
            </ToastProvider>
          </AuthProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
