/**
 * Next 客户端引导钩子（官方约定的插件注册点）：在任何前端代码执行前、
 * React hydration 之前初始化监控采集器——错误三源/卡死/web-vitals/会话
 * 生命周期。动态 import 保证 web-vitals 与采集逻辑不进首屏关键路径。
 * 服务端对偶钩子见 instrumentation.ts（Sentry + ImportJob 执行器接线）。
 */
void import('@/lib/monitor/collector').then((mod) => mod.initMonitorCollector());
