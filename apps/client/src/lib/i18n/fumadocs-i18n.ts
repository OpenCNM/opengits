import * as m from '@/paraglide/messages';

/**
 * 适配 fumadocs-ui 预制组件（右侧 TOC、内置搜索、分页等）所需的带作用域字符串字典。
 * 文案完全托管于 Paraglide 多语言词典，彻底消除在根 layout 中硬编码字典。
 */
export function getFumadocsTranslations(): Record<string, string> {
  return {
    'On this page(table of contents)': m.fumadocs_toc_title(),
    'Table of Contents(inline table of contents)': m.fumadocs_toc_title(),
    'No Headings(table of contents)': m.fumadocs_toc_empty(),
    'Search(search trigger)': m.fumadocs_search(),
    'Search(search dialog)': m.fumadocs_search(),
    'No results found(search dialog)': m.fumadocs_search_no_results(),
    'Previous Page(pagination)': m.dashboard_prev_page(),
    'Next Page(pagination)': m.dashboard_next_page(),
    'Last updated on(page footer)': m.fumadocs_last_updated(),
    'Choose a language(language switcher)': m.fumadocs_choose_language(),
  };
}
