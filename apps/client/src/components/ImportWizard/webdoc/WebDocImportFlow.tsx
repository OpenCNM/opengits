'use client';

import React from 'react';
import { useImportWizard } from '../ImportWizardContext';
import { WebDocScopeStep } from './WebDocScopeStep';
import { WebDocCrawlStep } from './WebDocCrawlStep';

export function WebDocImportFlow() {
  const { step, subStep } = useImportWizard();

  if (step === 1 && subStep === 'web_confirm') {
    return (
      <div className="flex flex-col items-center justify-center w-full py-2 px-4">
        <WebDocScopeStep />
      </div>
    );
  }

  return <WebDocCrawlStep />;
}
