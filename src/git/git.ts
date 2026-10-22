import { spawn } from 'child_process';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string
  ) {
    super(stderr.trim() || stdout.trim() || `git ${args[0]} exited with code ${exitCode}`);
    this.name = 'GitError';
  }
}

export interface RunOptions {
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

const env = {
  // Never block on an interactive prompt, pager or editor; messages are passed explicitly.
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  // Paths passed by the extension are exact file names, never globs (think `app/[id]/page.tsx`).
  GIT_LITERAL_PATHSPECS: '1',
  // English messages for error matching; LANGUAGE does not change the UTF-8 character set.
  LANGUAGE: 'en_US:en'
};

const LOCK_RETRIES = 3;

/** Runs git without a shell; resolves with stdout, rejects with GitError on a non-zero exit. */
export async function runGit(gitPath: string, args: readonly string[], options: RunOptions): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await spawnGit(gitPath, args, options);
    } catch (error) {
      // The built-in Git extension may hold index.lock for a moment; git fails before changing anything.
      if (!(error instanceof GitError) || !/index\.lock': File exists/.test(error.stderr) || attempt >= LOCK_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

function spawnGit(gitPath: string, args: readonly string[], options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, {
      cwd: options.cwd,
      signal: options.signal,
      env: { ...process.env, ...env, ...options.env }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (code === 0) {
        resolve(out);
      } else {
        reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8'), out));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}
