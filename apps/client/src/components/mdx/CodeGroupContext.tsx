'use client';

import React, { createContext, useContext } from 'react';

interface CodeGroupContextValue {
  isInGroup: boolean;
}

const CodeGroupContext = createContext<CodeGroupContextValue>({
  isInGroup: false,
});

export function CodeGroupProvider({ children }: { children: React.ReactNode }) {
  return (
    <CodeGroupContext.Provider value={{ isInGroup: true }}>
      {children}
    </CodeGroupContext.Provider>
  );
}

export function useCodeGroupContext() {
  return useContext(CodeGroupContext);
}
