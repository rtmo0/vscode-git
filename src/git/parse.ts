/** Parsers for machine-readable git output other than status. */

export type RefType = 'head' | 'remote' | 'tag';

export interface Ref {
  type: RefType;
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string;
  fullName: string;
  hash: string;
  /** For remote branches: the remote name; `name` without it is `remoteBranch`. */
  remote?: string;
  remoteBranch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  current: boolean;
  /** Unix seconds of the last commit or tag creation. */
  date: number;
}

export const REF_FORMAT = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(creatordate:unix)', '%(HEAD)'].join('%00');

/** Parses `git for-each-ref --format=REF_FORMAT`; `remotes` resolves remote names that contain slashes. */
export function parseRefs(output: string, remotes: readonly string[]): Ref[] {
  const byLength = [...remotes].sort((a, b) => b.length - a.length);
  const refs: Ref[] = [];
  for (const line of output.split('\n')) {
    if (!line) {
      continue;
    }
    const [fullName, hash, upstream, track, date, head] = line.split('\0');
    const ahead = /ahead (\d+)/.exec(track)?.[1];
    const behind = /behind (\d+)/.exec(track)?.[1];
    const common = {
      fullName,
      hash,
      upstream: upstream || undefined,
      ahead: ahead ? Number(ahead) : 0,
      behind: behind ? Number(behind) : 0,
      upstreamGone: track === 'gone',
      current: head === '*',
      date: Number(date) || 0
    };
    if (fullName.startsWith('refs/heads/')) {
      refs.push({ type: 'head', name: fullName.slice('refs/heads/'.length), ...common });
    } else if (fullName.startsWith('refs/remotes/')) {
      const name = fullName.slice('refs/remotes/'.length);
      const remote = byLength.find((r) => name.startsWith(r + '/')) ?? name.split('/')[0];
      const remoteBranch = name.slice(remote.length + 1);
      if (remoteBranch !== 'HEAD') {
        refs.push({ type: 'remote', name, remote, remoteBranch, ...common });
      }
    } else if (fullName.startsWith('refs/tags/')) {
      refs.push({ type: 'tag', name: fullName.slice('refs/tags/'.length), ...common });
    }
  }
  return refs;
}

export interface NameStatus {
  /** First status letter: A, M, D, R, C, T, U. */
  status: string;
  path: string;
  /** Source of a rename or copy. */
  origPath?: string;
}

/** Parses `--name-status -z` output of git diff, diff-tree and log. */
export function parseNameStatus(output: string): NameStatus[] {
  const records = output.split('\0');
  const result: NameStatus[] = [];
  for (let i = 0; i < records.length; i++) {
    const status = records[i];
    if (!status) {
      continue;
    }
    if (status[0] === 'R' || status[0] === 'C') {
      result.push({ status: status[0], origPath: records[i + 1], path: records[i + 2] });
      i += 2;
    } else {
      result.push({ status: status[0], path: records[i + 1] });
      i += 1;
    }
  }
  return result;
}

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  date: number;
  parents: string[];
  subject: string;
}

export const LOG_FORMAT = '%x1e' + ['%H', '%h', '%an', '%ae', '%at', '%P', '%s'].join('%x00');

/** Parses `git log --format=LOG_FORMAT`. */
export function parseLog(output: string): Commit[] {
  return output
    .split('\x1e')
    .filter((record) => record.trim())
    .map((record) => {
      const [hash, shortHash, author, authorEmail, date, parents, subject] = record.replace(/\n$/, '').split('\0');
      return { hash, shortHash, author, authorEmail, date: Number(date), parents: parents ? parents.split(' ') : [], subject };
    });
}

/** Branch names from `git reflog --format=%gs`, most recently checked out first, without duplicates. */
export function parseRecentCheckouts(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    const match = /^checkout: moving from (.+) to (.+)$/.exec(line);
    for (const name of match ? [match[2], match[1]] : []) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}
