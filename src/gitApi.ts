import * as vscode from 'vscode';

/** The subset of the built-in Git extension API (`vscode.git`, version 1) used by Git Awesome. */

/** `ForcePushMode.ForceWithLease` of the built-in API. */
export const FORCE_WITH_LEASE = 1;

export interface FetchOptions {
  remote?: string;
  ref?: string;
  all?: boolean;
}

export interface ApiRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
  fetch(options?: FetchOptions): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: number): Promise<void>;
}

export interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: ApiRepository[];
  readonly onDidOpenRepository: vscode.Event<ApiRepository>;
  readonly onDidCloseRepository: vscode.Event<ApiRepository>;
}

export async function getGitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<{ enabled: boolean; getAPI(version: 1): GitApi }>('vscode.git');
  const exports = await extension?.activate();
  return exports?.enabled ? exports.getAPI(1) : undefined;
}

/** Error code the built-in extension attaches to a rejected (non-fast-forward) push. */
export function isPushRejected(error: unknown): boolean {
  const { gitErrorCode, stderr, message } = error as { gitErrorCode?: string; stderr?: string; message?: string };
  return gitErrorCode === 'PushRejected' || /\[rejected\]|non-fast-forward|fetch first/.test(`${stderr ?? ''}${message ?? ''}`);
}
