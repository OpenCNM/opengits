"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useSafeSession } from "@/lib/useSafeSession";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuLinkItem } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { User, LogOut } from "lucide-react";
import { useGuestStore } from "@/lib/stores/guest-store";
import * as m from '@/paraglide/messages';

import { Skeleton } from "@/components/ui/skeleton";

interface UserMenuProps {
  initialUserId?: string | null;
}

export function UserMenu({ initialUserId }: UserMenuProps = {}) {
  const { data: session, status } = useSafeSession();
  const isGuest = useGuestStore((s) => s.isGuest);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 🚀 Zero-Layout-Shift / Anti-Jitter Hydration Strategy
  if (!mounted || status === "loading") {
    // If unauthenticated (default for visitors), render the login button directly to prevent 32px circle -> 58px button width jumping
    if (!initialUserId && status !== "authenticated") {
      return (
        <Button
          variant="outline"
          className="h-8 px-3 text-xs font-sans rounded-lg border border-theme-border/80 bg-theme-surface/60 hover:bg-theme-surface hover:text-theme-foreground transition-all shadow-none"
          render={<Link href="/auth/signin" />}
        >{m.common_signin()}</Button>
      );
    }
    // If authenticated, render a matching 32px circle skeleton without shifting
    return <Skeleton className="h-8 w-8 rounded-full shrink-0" />;
  }

  if (!session) {
    if (isGuest) {
      return (
        <Menu>
          <MenuTrigger
            aria-label="Guest user menu"
            className="w-8 h-8 rounded-full border border-theme-border/80 bg-theme-surface flex items-center justify-center text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/80 transition-all cursor-pointer shadow-2xs focus:outline-none focus:ring-2 focus:ring-theme-primary/40"
          >
            <User className="w-4 h-4 text-theme-muted" />
          </MenuTrigger>

          <MenuPopup align="end" sideOffset={8} className="w-32 bg-theme-bg border border-theme-border shadow-xl rounded-xl p-1.5 font-sans">
            <MenuItem
              className="w-full text-left px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 rounded-lg cursor-pointer outline-none transition-colors font-medium flex items-center gap-2"
              onClick={() => {
                useGuestStore.getState().clearGuestMode();
                if (typeof window !== 'undefined') {
                  window.location.href = '/';
                }
              }}
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{m.auth_guest_exit()}</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
      );
    }

    return (
      <Button
        variant="outline"
        className="h-8 px-3 text-xs font-sans rounded-lg border border-theme-border/80 bg-theme-surface/60 hover:bg-theme-surface hover:text-theme-foreground transition-all shadow-none"
        render={<Link href="/auth/signin" />}
      >{m.common_signin()}</Button>
    );
  }

  const user = session.user;
  const initials = user?.name?.slice(0, 2)?.toUpperCase() || "US";

  return (
    <Menu>
      <MenuTrigger className="rounded-full focus:outline-none focus:ring-2 focus:ring-sky-400">
        <Avatar className="cursor-pointer border border-theme-border/80 hover:opacity-80 transition-opacity w-8 h-8">
          <AvatarImage src={user?.image || ""} alt={user?.name || "User avatar"} crossOrigin="anonymous" />
          <AvatarFallback className="bg-theme-surface text-theme-muted text-micro font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
      </MenuTrigger>

      <MenuPopup align="end" sideOffset={8} className="w-44 bg-theme-bg border border-theme-border shadow-xl rounded-xl p-1.5 font-sans">
        {/* Section 1: Quick Actions */}
        <div className="space-y-0.5">
          <MenuLinkItem
            render={<Link href="/settings/publications" />}
            className="w-full text-left px-3 py-1.5 text-xs text-theme-foreground hover:bg-theme-surface rounded-xl cursor-pointer outline-none transition-colors"
          >
            <span>{m.user_menu_publications()}</span>
          </MenuLinkItem>

          <MenuLinkItem
            render={<Link href="/settings/usage" />}
            className="w-full text-left px-3 py-1.5 text-xs text-theme-foreground hover:bg-theme-surface rounded-xl cursor-pointer outline-none transition-colors"
          >
            <span>{m.user_menu_usage()}</span>
          </MenuLinkItem>

          <MenuLinkItem
            render={<Link href="/settings/mcp-tokens" />}
            className="w-full text-left px-3 py-1.5 text-xs text-theme-foreground hover:bg-theme-surface rounded-xl cursor-pointer outline-none transition-colors"
          >
            <span>{m.user_menu_mcp_tokens()}</span>
          </MenuLinkItem>

          <MenuLinkItem
            render={<Link href="/settings/api-keys" />}
            className="w-full text-left px-3 py-1.5 text-xs text-theme-foreground hover:bg-theme-surface rounded-xl cursor-pointer outline-none transition-colors"
          >
            <span>{m.user_menu_api_keys()}</span>
          </MenuLinkItem>

          <MenuLinkItem
            render={<Link href="/settings/account" />}
            className="w-full text-left px-3 py-1.5 text-xs text-theme-foreground hover:bg-theme-surface rounded-xl cursor-pointer outline-none transition-colors"
          >
            <span>{m.user_menu_account()}</span>
          </MenuLinkItem>
        </div>

        <div className="border-t border-theme-border my-1" />

        {/* Section 2: Account Actions */}
        <MenuItem
          className="w-full text-left px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 rounded-xl cursor-pointer outline-none transition-colors font-medium"
          onClick={() => signOut()}
        >
          <span>{m.user_menu_sign_out()}</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
