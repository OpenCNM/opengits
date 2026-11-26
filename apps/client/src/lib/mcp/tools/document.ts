import { RepoRuntime } from './shared';
import { runOutline, formatNavTree, findDocInContext } from './outline';
import { runRead, capFullDocText, fetchDocumentContent } from './read';

export {
  runOutline,
  formatNavTree,
  findDocInContext,
  runRead,
  capFullDocText,
  fetchDocumentContent,
};

export async function runReadDocument(
  args: { repository?: string; path?: string; section?: string },
  runtime: RepoRuntime,
  telemetryId?: string
) {
  if (args.section) {
    const target = args.section.includes('#')
      ? args.section
      : args.path
      ? `${args.path}#${args.section}`
      : args.section;
    return runRead({ repository: args.repository, target }, runtime, telemetryId);
  }
  if (args.path) {
    return runRead({ repository: args.repository, target: args.path }, runtime, telemetryId);
  }
  return runOutline({ repository: args.repository }, runtime, telemetryId);
}
