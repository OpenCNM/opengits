import { create } from 'zustand';
import type { PermissionGateOptions, SignInOptionsArgs } from './types';

interface PermissionStoreState {
  isAuthenticated: boolean;
  userId: string | null;

  // 统一权限拦截弹窗
  permissionGateOpen: boolean;
  gateOptions: PermissionGateOptions | null;

  // 双通道登录选择器弹窗 (GitHub vs 游客)
  signInOptionsOpen: boolean;
  signInOptionsArgs: SignInOptionsArgs | null;

  // Actions
  setAuthState: (isAuthenticated: boolean, userId?: string | null) => void;
  openPermissionGate: (options: PermissionGateOptions) => void;
  closePermissionGate: () => void;
  openSignInOptions: (args?: SignInOptionsArgs) => void;
  closeSignInOptions: () => void;
}

export const usePermissionStore = create<PermissionStoreState>((set) => ({
  isAuthenticated: false,
  userId: null,

  permissionGateOpen: false,
  gateOptions: null,

  signInOptionsOpen: false,
  signInOptionsArgs: null,

  setAuthState: (isAuthenticated, userId = null) => {
    set({ isAuthenticated, userId });
  },

  openPermissionGate: (options) => {
    set({
      permissionGateOpen: true,
      gateOptions: options,
    });
  },

  closePermissionGate: () => {
    set({
      permissionGateOpen: false,
      gateOptions: null,
    });
  },

  openSignInOptions: (args) => {
    set({
      signInOptionsOpen: true,
      signInOptionsArgs: args ?? null,
    });
  },

  closeSignInOptions: () => {
    set({
      signInOptionsOpen: false,
      signInOptionsArgs: null,
    });
  },
}));
