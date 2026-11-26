import type { GitHubNode } from '../fetcher';
import { executeSidecarArchiveTree } from '../sniffer-driver';

export async function treeFromArchive(
  owner: string,
  repo: string,
  sha: string
): Promise<GitHubNode[]> {
  return await executeSidecarArchiveTree(owner, repo, sha);
}
