import { describe, it, expect, beforeEach, vi } from 'vitest';

const storeMap = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => storeMap.set(k, String(v)),
  removeItem: (k: string) => storeMap.delete(k),
  clear: () => storeMap.clear(),
  length: 0,
  key: (i: number) => Array.from(storeMap.keys())[i] || null,
};

const eventListeners: Record<string, ((e: any) => void)[]> = {};
const windowMock = {
  localStorage: localStorageMock,
  addEventListener: (event: string, cb: any) => {
    (eventListeners[event] ??= []).push(cb);
  },
  removeEventListener: (event: string, cb: any) => {
    if (eventListeners[event]) {
      eventListeners[event] = eventListeners[event].filter((fn) => fn !== cb);
    }
  },
  dispatchEvent: (event: any) => {
    eventListeners[event.type]?.forEach((cb) => cb(event));
    return true;
  },
};

vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('window', windowMock);

import { useGuestStore, ENABLE_GUEST_MODE, initGuestCrossTabSync } from '@/lib/stores/guest-store';
import { usePermissionStore } from '@/lib/permissions/permission-store';
import {
  withPermission,
  requireAuth,
  requireAiCapability,
  promptSignInOptions,
} from '@/lib/permissions/permission-gateway';
import { STORAGE_KEYS } from '@/lib/constants';
import * as m from '@/paraglide/messages';

// Mock api-key-guard
vi.mock('@/lib/api-key-guard', () => ({
  hasConfiguredApiKey: vi.fn(),
  requireApiKey: vi.fn((onSuccess) => {
    return false;
  }),
}));

import { hasConfiguredApiKey, requireApiKey } from '@/lib/api-key-guard';

describe('Guest Mode Store & Zero-Residue Invariants', () => {
  beforeEach(() => {
    localStorage.clear();
    initGuestCrossTabSync();
    useGuestStore.getState().clearGuestMode();
    usePermissionStore.getState().setAuthState(false, null);
    usePermissionStore.getState().closePermissionGate();
    usePermissionStore.getState().closeSignInOptions();
    vi.clearAllMocks();
  });

  it('activates guest mode and persists session to localStorage', () => {
    expect(ENABLE_GUEST_MODE).toBe(true);
    expect(useGuestStore.getState().isGuest).toBe(false);

    useGuestStore.getState().setGuestMode(true, 'ggml-org/llama.cpp');

    expect(useGuestStore.getState().isGuest).toBe(true);
    expect(useGuestStore.getState().lastViewedRepo).toBe('ggml-org/llama.cpp');

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.GUEST_SESSION) || '{}');
    expect(stored.isGuest).toBe(true);
    expect(stored.lastViewedRepo).toBe('ggml-org/llama.cpp');
  });

  it('activates guest mode via enableGuestMode helper', () => {
    useGuestStore.getState().enableGuestMode('pytorch/torchtune');
    expect(useGuestStore.getState().isGuest).toBe(true);
    expect(useGuestStore.getState().lastViewedRepo).toBe('pytorch/torchtune');
  });

  it('guarantees zero-residue cleanup on clearGuestMode', () => {
    useGuestStore.getState().setGuestMode(true, 'vllm-project/vllm');
    expect(localStorage.getItem(STORAGE_KEYS.GUEST_SESSION)).not.toBeNull();

    useGuestStore.getState().clearGuestMode();

    expect(useGuestStore.getState().isGuest).toBe(false);
    expect(useGuestStore.getState().lastViewedRepo).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.GUEST_SESSION)).toBeNull();
  });

  it('smoothly clears guest mode when real authenticated session is established', () => {
    useGuestStore.getState().setGuestMode(true, 'facebook/react');
    expect(useGuestStore.getState().isGuest).toBe(true);

    // Simulate session authentication event
    const fakeUserId = 'usr_test_123';
    usePermissionStore.getState().setAuthState(true, fakeUserId);
    useGuestStore.getState().clearGuestMode();

    expect(useGuestStore.getState().isGuest).toBe(false);
    expect(useGuestStore.getState().lastViewedRepo).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.GUEST_SESSION)).toBeNull();
  });

  it('synchronizes guest store across tabs via storage event on clear', () => {
    useGuestStore.getState().setGuestMode(true, 'tokio-rs/tokio');
    expect(useGuestStore.getState().isGuest).toBe(true);

    // Tab 1 logged in, emitted storage event clearing guest session
    windowMock.dispatchEvent({
      type: 'storage',
      key: STORAGE_KEYS.GUEST_SESSION,
      newValue: null,
    });

    expect(useGuestStore.getState().isGuest).toBe(false);
    expect(useGuestStore.getState().lastViewedRepo).toBeNull();
  });

  it('synchronizes guest store across tabs via storage event on update', () => {
    expect(useGuestStore.getState().isGuest).toBe(false);

    // Tab 1 selected guest mode for a repo
    windowMock.dispatchEvent({
      type: 'storage',
      key: STORAGE_KEYS.GUEST_SESSION,
      newValue: JSON.stringify({ isGuest: true, lastViewedRepo: 'torvalds/linux' }),
    });

    expect(useGuestStore.getState().isGuest).toBe(true);
    expect(useGuestStore.getState().lastViewedRepo).toBe('torvalds/linux');
  });
});

describe('Unified Permission Gateway & Probe Interception', () => {
  beforeEach(() => {
    localStorage.clear();
    initGuestCrossTabSync();
    useGuestStore.getState().clearGuestMode();
    usePermissionStore.getState().setAuthState(false, null);
    usePermissionStore.getState().closePermissionGate();
    usePermissionStore.getState().closeSignInOptions();
    vi.clearAllMocks();
  });

  it('🟢 READ permission: unconditionally executes action for visitors and guests', () => {
    const action = vi.fn();
    const result = withPermission('READ', action);

    expect(result).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(usePermissionStore.getState().permissionGateOpen).toBe(false);
  });

  it('🟡 USER_ASSET permission: intercepts unauthenticated users and opens gate modal', () => {
    const action = vi.fn();
    const result = requireAuth(action, '收藏此教程需要登录');

    expect(result).toBe(false);
    expect(action).not.toHaveBeenCalled();

    const gateState = usePermissionStore.getState();
    expect(gateState.permissionGateOpen).toBe(true);
    expect(gateState.gateOptions?.level).toBe('USER_ASSET');
    expect(gateState.gateOptions?.contextText).toBe('收藏此教程需要登录');
  });

  it('🟡 USER_ASSET permission: immediately allows authenticated user actions', () => {
    usePermissionStore.getState().setAuthState(true, 'usr_valid_456');

    const action = vi.fn();
    const result = requireAuth(action);

    expect(result).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(usePermissionStore.getState().permissionGateOpen).toBe(false);
  });

  it('🔴 AI_COMPUTE permission: intercepts unauthenticated user with AI gate modal', () => {
    const action = vi.fn();
    const result = requireAiCapability(action, 'AI 划词问答');

    expect(result).toBe(false);
    expect(action).not.toHaveBeenCalled();

    const gateState = usePermissionStore.getState();
    expect(gateState.permissionGateOpen).toBe(true);
    expect(gateState.gateOptions?.level).toBe('AI_COMPUTE');
    expect(gateState.gateOptions?.contextText).toBe('AI 划词问答');
  });

  it('🔴 AI_COMPUTE permission: delegates to requireApiKey when authenticated', () => {
    usePermissionStore.getState().setAuthState(true, 'usr_valid_456');
    vi.mocked(requireApiKey).mockReturnValue(true);

    const action = vi.fn();
    const result = requireAiCapability(action, '新项目转录');

    expect(result).toBe(true);
    expect(requireApiKey).toHaveBeenCalled();
  });

  it('prompts sign in options modal with target repo', () => {
    promptSignInOptions({
      targetRepo: {
        owner: 'ggml-org',
        repo: 'llama.cpp',
        title: 'llama.cpp 纯 C++ 异构推理',
      },
    });

    const state = usePermissionStore.getState();
    expect(state.signInOptionsOpen).toBe(true);
    expect(state.signInOptionsArgs?.targetRepo?.owner).toBe('ggml-org');
    expect(state.signInOptionsArgs?.targetRepo?.repo).toBe('llama.cpp');
  });

  it('verifies footer note translation exists for guest modal', () => {
    expect(typeof m.auth_modal_footer_note).toBe('function');
    expect(m.auth_modal_footer_note().length).toBeGreaterThan(0);
  });
});
