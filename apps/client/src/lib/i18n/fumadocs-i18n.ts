import * as m from '@/paraglide/messages';

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
