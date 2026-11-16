export interface GlobalModelProviderDTO {
  id: string;
  providerKey: string;
  name: string;
  label: string;
  badgeLabel: string;
  baseUrl: string;
  apiFormat: 'openai' | 'anthropic';
  defaultModel: string;
  models: string[];
  isEnabled: boolean;
  isDefault: boolean;
  displayOrder: number;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateModelProviderInput {
  providerKey: string;
  name: string;
  label: string;
  badgeLabel: string;
  baseUrl: string;
  apiFormat?: 'openai' | 'anthropic';
  defaultModel: string;
  models: string[];
  isEnabled?: boolean;
  isDefault?: boolean;
  displayOrder?: number;
  description?: string | null;
}
