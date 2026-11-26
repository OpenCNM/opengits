// Forces compile-time exhaustiveness errors on discriminated-union switch statements.
export function assertNever(value: never, context?: string): never {
  const rendered =
    value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
  throw new Error(
    `Unhandled discriminated state: ${rendered}${context ? ` (in ${context})` : ''}`
  );
}
