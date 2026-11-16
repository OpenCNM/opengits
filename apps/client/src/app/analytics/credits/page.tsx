import React from 'react';
import { CreditLedgerView } from '@/components/credits/CreditLedgerView';
import { SubpageContainer } from '@/components/layout/SubpageContainer';

export default function CreditLedgerPage() {
  return (
    <SubpageContainer maxWidth="4xl">
      <CreditLedgerView />
    </SubpageContainer>
  );
}
