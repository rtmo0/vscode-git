/** Parser for `git status --porcelain=v2 --branch -z`. */

export type ChangeKind = 'changed' | 'renamed' | 'conflicted' | 'untracked' | 'ignored';

export interface FileChange {
  kind: ChangeKind;
  path: string;
  /** Source path of a rename or copy. */
  origPath?: string;
  /** Index status letter, '.' when unchanged; '?' or '!' for untracked and ignored files. */
  index: string;
  /** Working tree status letter, '.' when unchanged; '?' or '!' for untracked and ignored files. */
  workTree: string;
}

export interface BranchInfo {
  /** Undefined on an unborn branch. */
  oid?: string;
  /** Undefined when HEAD is detached. */
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface Status {
  branch: BranchInfo;
  changes: FileChange[];
}

/** Returns the remainder of `line` after `count` space-separated fields; paths may contain spaces. */
function tail(line: string, count: number): string {
  let at = 0;
  for (let i = 0; i < count; i++) {
    at = line.indexOf(' ', at) + 1;
  }
  return line.slice(at);
}

export function parseStatus(output: string): Status {
  const branch: BranchInfo = { ahead: 0, behind: 0 };
  const changes: FileChange[] = [];
  const records = output.split('\0');

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) {
      continue;
    }
    const xy = record.slice(2, 4);
    switch (record[0]) {
      case '#': {
        const [, key, ...values] = record.split(' ');
        if (key === 'branch.oid' && values[0] !== '(initial)') {
          branch.oid = values[0];
        } else if (key === 'branch.head' && values[0] !== '(detached)') {
          branch.head = values.join(' ');
        } else if (key === 'branch.upstream') {
          branch.upstream = values.join(' ');
        } else if (key === 'branch.ab') {
          branch.ahead = Number(values[0]);
          branch.behind = -Number(values[1]);
        }
        break;
      }
      case '1':
        changes.push({ kind: 'changed', path: tail(record, 8), index: xy[0], workTree: xy[1] });
        break;
      case '2':
        // The rename source follows as its own NUL-terminated record.
        changes.push({ kind: 'renamed', path: tail(record, 9), origPath: records[++i], index: xy[0], workTree: xy[1] });
        break;
      case 'u':
        changes.push({ kind: 'conflicted', path: tail(record, 10), index: xy[0], workTree: xy[1] });
        break;
      case '?':
        changes.push({ kind: 'untracked', path: record.slice(2), index: '?', workTree: '?' });
        break;
      case '!':
        changes.push({ kind: 'ignored', path: record.slice(2), index: '!', workTree: '!' });
        break;
    }
  }
  return { branch, changes };
}
