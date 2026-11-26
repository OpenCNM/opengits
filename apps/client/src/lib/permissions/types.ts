export type PermissionLevel =
  | 'READ'
  | 'USER_ASSET'
  | 'AI_COMPUTE';

export interface PermissionGateOptions {
  level: 'USER_ASSET' | 'AI_COMPUTE';
  title?: string;
  contextText?: string;
  onResolved?: () => void;
}

export interface SignInOptionsArgs {
  targetRepo?: {
    owner: string;
    repo: string;
    title?: string;
  } | null;
  callbackUrl?: string;
}
