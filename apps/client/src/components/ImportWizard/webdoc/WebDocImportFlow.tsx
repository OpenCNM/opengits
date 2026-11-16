'use client';

import React from 'react';
import { useImportWizard } from '../ImportWizardContext';
import { WebDocScopeStep } from './WebDocScopeStep';
import { WebDocCrawlStep } from './WebDocCrawlStep';

/**
 * WebDoc 专属非输入阶段流程分发器：
 * 完全脱离 GitHub 的 Step1URLInput / ScoutFeedbackCard / ImportWorkbench。
 */
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
