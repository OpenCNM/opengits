'use client';

import { useEffect } from 'react';
import { Key } from 'lucide-react';
import { useModalStore } from '@/lib/stores/modal-store';
import { useSettingsStore } from '@/lib/stores/settings-store';

export default function DynamicVar({ name, fallback = 'YOUR_API_KEY' }: { name: string, fallback?: string }) {
  // 动态变量真相源在 settings store 的 vars 注册表（vars 挂载时从 opengits_var_* 裸键恢复，
  // 订阅替代原 SETTINGS_UPDATED 事件监听；未设置时保持 fallback，SSR/首帧输出一致）
  const value = useSettingsStore((s) => s.vars[name]) || fallback;

  useEffect(() => {
    useSettingsStore.getState().initSettings();
  }, [name]);

  const isDefault = value === fallback;

  return (
    <span
      className={`font-mono px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
        isDefault
          ? 'bg-theme-primary/10 text-theme-primary border border-theme-primary/30 '
          : 'bg-emerald-800/10 text-emerald-800 border border-emerald-800/30 '
      }`}
      onClick={() => useModalStore.getState().openPreferencesModal('llm')}
      title={isDefault ? "Click to set this environment variable" : "Injected from your settings"}
    >
      {isDefault && <Key size={12} className="inline mr-1 -mt-0.5" />}
      {value}
    </span>
  );
}
