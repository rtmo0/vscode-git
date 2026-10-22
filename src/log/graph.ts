/** Commit graph layout for the Log: one lane per line of history, drawn row by row. */

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/**
 * A line inside a row. The top half runs from lane `from` at the row top to lane `to` at the row middle,
 * the bottom half from lane `from` at the middle to lane `to` at the row bottom.
 */
export interface Segment {
  half: 'top' | 'bottom';
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  /** Lane of the commit node. */
  lane: number;
  color: number;
  segments: Segment[];
  /** Number of lanes used by this row. */
  width: number;
}

interface Lane {
  /** The commit this line leads to. */
  hash: string;
  color: number;
}

/** Lays out commits given newest first, each after all of its children (`git log --date-order`). */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  let lanes: Lane[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const segments: Segment[] = [];
    let lane = lanes.findIndex((l) => l.hash === commit.hash);
    const isTip = lane < 0;
    if (isTip) {
      // A branch tip: no line comes into the node from above.
      lane = lanes.length;
      lanes.push({ hash: commit.hash, color: nextColor++ });
    }
    const color = lanes[lane].color;
    lanes.forEach((l, j) => {
      if (l.hash !== commit.hash) {
        segments.push({ half: 'top', from: j, to: j, color: l.color });
      } else if (!(isTip && j === lane)) {
        // Every line that leads to this commit ends in its node.
        segments.push({ half: 'top', from: j, to: lane, color: l.color });
      }
    });

    // Lanes below the node: pass-through lines keep their order, the node continues into its
    // first parent in its own lane and opens lanes to the right for other parents.
    const below: (Lane & { from: number })[] = [];
    const known = new Set(lanes.map((l) => l.hash));
    lanes.forEach((l, j) => {
      if (l.hash !== commit.hash) {
        below.push({ ...l, from: j });
      } else if (j === lane) {
        commit.parents.forEach((parent, k) => {
          if (!known.has(parent) && !below.some((b) => b.hash === parent)) {
            below.push({ hash: parent, color: k === 0 ? color : nextColor++, from: lane });
          }
        });
      }
    });
    below.forEach((b, k) => segments.push({ half: 'bottom', from: b.from, to: k, color: b.color }));
    // A parent that another line already leads to: join that line.
    for (const parent of commit.parents) {
      const k = below.findIndex((b) => b.hash === parent);
      if (k >= 0 && below[k].from !== lane) {
        segments.push({ half: 'bottom', from: lane, to: k, color: below[k].color });
      }
    }

    rows.push({ lane, color, segments, width: Math.max(lanes.length, below.length) });
    lanes = below.map(({ hash, color: c }) => ({ hash, color: c }));
  }
  return rows;
}
