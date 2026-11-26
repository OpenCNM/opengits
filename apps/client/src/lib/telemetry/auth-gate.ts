let telemetryAuthenticated = false;

export function setTelemetryAuthenticated(authenticated: boolean): void {
  telemetryAuthenticated = authenticated;
}

export function isTelemetryAuthenticated(): boolean {
  return telemetryAuthenticated;
}
