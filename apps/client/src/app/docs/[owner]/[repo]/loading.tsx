import { OgLoading } from '@/components/ui/OgLoading';
import * as m from '@/paraglide/messages';

export default function DocsLoading() {
  return (
    <OgLoading
      fullPage
      size="xl"
      text={m.uninitialized_chapter_ready_loading?.() || m.common_loading()}
    />
  );
}
