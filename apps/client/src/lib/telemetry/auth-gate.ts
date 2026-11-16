/**
 * 遥测/监控共用的登录态门（中性模块，无任何通道语义）。
 * 写方：AuthProvider（沿用 beacon 的 re-export，零改动）。
 * 读方：journey beacon 与 monitor transport 各自拦截未登录上报，防 401 噪音。
 * 抽出本模块的动机：插件化解耦后 beacon 与 monitor 互不感知，
 * 二者仅共享这一个单向依赖的登录态事实源。
 */

let telemetryAuthenticated = false;

export function setTelemetryAuthenticated(authenticated: boolean): void {
  telemetryAuthenticated = authenticated;
}

export function isTelemetryAuthenticated(): boolean {
  return telemetryAuthenticated;
}
