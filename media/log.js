// @ts-check
/* The Log tab of the Git tool window: branches tree, commit graph table and commit details. */
(function () {
  const vscode = acquireVsCodeApi();
  const ROW = 24;
  const LANE = 16;
  const COLORS = ['#4a9eff', '#f0a732', '#4fbf6a', '#c977e6', '#ef6b62', '#3cc2c0', '#e68a4c', '#8f96f5', '#d4c43a', '#e35d9b'];

  /** @type {any} */
  const saved = vscode.getState() || {};
  const state = {
    repos: [],
    repo: undefined,
    head: undefined,
    headName: undefined,
    refs: [],
    commits: [],
    filters: {},
    hasMore: false,
    loadingMore: false,
    selected: undefined,
    details: undefined,
    containing: undefined,
    expanded: saved.expanded || {},
    left: saved.left || 240,
    right: saved.right || 340,
    /** Height share of the changed files in the details pane. */
    filesShare: saved.filesShare || 0.55,
    columns: { author: 150, date: 150, hash: 80, ...saved.columns },
    hidden: saved.hidden || {},
    /** Graph column width set by the user; undefined fits the graph. */
    graphColumn: saved.graphColumn,
    branchFilter: ''
  };
  const save = () =>
    vscode.setState({ expanded: state.expanded, left: state.left, right: state.right, filesShare: state.filesShare, columns: state.columns, hidden: state.hidden, graphColumn: state.graphColumn });
  /** Fixed-width columns after Subject, which takes the remaining space. */
  const COLUMNS = /** @type {const} */ (['author', 'date', 'hash']);
  const COLUMN_TITLES = { author: 'Author', date: 'Date', hash: 'Hash' };
  const visibleColumns = () => COLUMNS.filter((c) => !state.hidden[c]);

  /** @param {string} tag @param {Record<string, any>} [props] @param {(Node|string)[]} [children] */
  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      // The CSP forbids style attributes; CSSOM assignments are allowed.
      else if (key === 'style') el.style.cssText = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== false) el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) el.append(child);
    return el;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  /** @param {string} tag @param {Record<string, any>} attrs */
  function s(tag, attrs) {
    const el = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (String(value).startsWith('var(')) el.style.setProperty(key, String(value));
      else el.setAttribute(key, String(value));
    }
    return el;
  }

  const ICONS = {
    branch: '<svg viewBox="0 0 16 16"><path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm9-6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM3.5 5v6M12.5 8c0 2.5-3 2.5-6 3.5L3.5 11" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    tag: '<svg viewBox="0 0 16 16"><path d="M2 2h6l6 6-6 6-6-6z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h5l1.5 1.5h6.5v8h-13z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    cloud: '<svg viewBox="0 0 16 16"><path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7 1A2.5 2.5 0 0 1 11.5 12.5z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    head: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.5" fill="currentColor"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    star: '<svg viewBox="0 0 16 16"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/></svg>',
    chevron: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
  };
  /** @param {keyof typeof ICONS} name */
  function icon(name, cls = '') {
    const span = h('span', { class: `icon ${cls}` });
    span.innerHTML = ICONS[name];
    return span;
  }

  // ---------- Layout ----------
  const repoSelect = h('select', { class: 'repo', title: 'Repository', onchange: () => vscode.postMessage({ type: 'selectRepo', root: repoSelect.value }) });
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Text or hash', spellcheck: 'false' });
  const branchSelect = h('select', { title: 'Branch' });
  const author = h('input', { class: 'author', type: 'search', placeholder: 'User', spellcheck: 'false' });
  const status = h('span', { class: 'status' });
  const toolbar = h('div', { class: 'toolbar' }, [
    repoSelect,
    h('label', { class: 'filter' }, [search]),
    h('label', { class: 'filter' }, [h('span', { text: 'Branch:' }), branchSelect]),
    h('label', { class: 'filter' }, [h('span', { text: 'User:' }), author]),
    status
  ]);

  const branchFilter = h('input', { class: 'branch-filter', type: 'search', placeholder: 'Search branches', spellcheck: 'false' });
  const branchTree = h('div', { class: 'tree', tabindex: '0' });
  const branchesPane = h('div', { class: 'pane branches' }, [branchFilter, branchTree]);

  const header = h('div', { class: 'header row-grid' });
  const spacer = h('div', { class: 'spacer' });
  const rows = h('div', { class: 'rows', tabindex: '0' }, [spacer]);
  const empty = h('div', { class: 'empty' });
  const logPane = h('div', { class: 'pane log' }, [header, rows, empty]);

  const files = h('div', { class: 'files tree' });
  const message = h('div', { class: 'message' });
  const filesSplit = h('div', { class: 'hsplit', title: 'Drag to resize' });
  const detailsPane = h('div', { class: 'pane details' }, [files, filesSplit, message]);

  const leftSplit = h('div', { class: 'splitter' });
  const rightSplit = h('div', { class: 'splitter' });
  const main = h('div', { class: 'main' }, [branchesPane, leftSplit, logPane, rightSplit, detailsPane]);
  const menu = h('div', { class: 'menu', hidden: true });
  document.body.append(toolbar, main, menu);

  function applyWidths() {
    main.style.gridTemplateColumns = `${state.left}px 5px minmax(240px, 1fr) 5px ${state.right}px`;
    files.style.flex = `0 0 ${Math.round(state.filesShare * 100)}%`;
  }
  applyWidths();

  // ---------- Columns ----------
  function applyColumns() {
    const graph = graphColumnWidth();
    const template = [`${graph}px`, 'minmax(120px, 1fr)', ...visibleColumns().map((c) => `${state.columns[c]}px`)].join(' ');
    logPane.style.setProperty('--columns', template);
    // A graph wider than its column fades out at the right edge.
    logPane.classList.toggle('graph-clipped', graph < fullGraphWidth());
  }

  /** Drags with the mouse; `onMove` gets the horizontal and vertical distance from the start. */
  function drag(/** @type {MouseEvent} */ event, /** @type {(dx: number, dy: number) => void} */ onMove, vertical = false) {
    event.preventDefault();
    event.stopPropagation();
    const { clientX, clientY } = event;
    const cls = vertical ? 'dragging-row' : 'dragging';
    document.body.classList.add(cls);
    const move = (/** @type {MouseEvent} */ e) => onMove(e.clientX - clientX, e.clientY - clientY);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove(cls);
      save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function renderHeader() {
    // Between the graph and Subject: dragging right widens the graph, double-click fits it again.
    const graphResizer = h('div', {
      class: 'col-resizer',
      title: 'Drag to resize the graph · Double-click to fit',
      onmousedown: (/** @type {MouseEvent} */ e) => {
        const start = graphColumnWidth();
        drag(e, (dx) => {
          state.graphColumn = Math.max(16, Math.min(start + dx, 1200));
          applyColumns();
        });
      },
      ondblclick: () => {
        state.graphColumn = undefined;
        save();
        applyColumns();
      }
    });
    const cells = [h('div', { class: 'col graph-col', title: 'Graph' }), h('div', { class: 'col' }, [graphResizer, h('span', { text: 'Subject' })])];
    for (const column of visibleColumns()) {
      // The handle on the left edge of a fixed column resizes it: dragging left widens it.
      const resizer = h('div', {
        class: 'col-resizer',
        title: 'Drag to resize',
        onmousedown: (/** @type {MouseEvent} */ e) => {
          const start = state.columns[column];
          drag(e, (dx) => {
            state.columns[column] = Math.max(40, Math.min(start - dx, 600));
            applyColumns();
          });
        }
      });
      cells.push(h('div', { class: 'col' }, [resizer, h('span', { text: COLUMN_TITLES[column] })]));
    }
    header.replaceChildren(...cells);
  }
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showLocalMenu(
      e.clientX,
      e.clientY,
      COLUMNS.map((column) => ({
        label: `${state.hidden[column] ? '\u2003' : '\u2713'} ${COLUMN_TITLES[column]}`,
        run: () => {
          state.hidden[column] = !state.hidden[column];
          save();
          applyColumns();
          renderHeader();
          renderRows(true);
        }
      })).concat([
        {
          label: '\u2003 Reset Column Widths',
          run: () => {
            state.columns = { author: 150, date: 150, hash: 80 };
            state.graphColumn = undefined;
            state.hidden = {};
            save();
            applyColumns();
            renderHeader();
            renderRows(true);
          }
        }
      ])
    );
  });
  applyColumns();
  renderHeader();

  filesSplit.addEventListener('mousedown', (e) => {
    const start = state.filesShare;
    const height = detailsPane.clientHeight || 1;
    drag(e, (_dx, dy) => {
      state.filesShare = Math.max(0.15, Math.min(0.85, start + dy / height));
      applyWidths();
    }, true);
  });

  /** @param {HTMLElement} splitter @param {'left'|'right'} side */
  function dragSplitter(splitter, side) {
    splitter.title = 'Drag to resize';
    splitter.addEventListener('mousedown', (event) => {
      const start = state[side];
      drag(event, (dx) => {
        state[side] = Math.max(120, Math.min(start + (side === 'left' ? dx : -dx), window.innerWidth - 360));
        applyWidths();
        renderRows();
      });
    });
  }
  dragSplitter(leftSplit, 'left');
  dragSplitter(rightSplit, 'right');

  // ---------- Filters ----------
  function sendFilters() {
    vscode.postMessage({
      type: 'filters',
      filters: { branch: branchSelect.value || undefined, author: author.value.trim() || undefined, text: search.value.trim() || undefined }
    });
  }
  /** @type {any} */
  let filterTimer;
  const debounced = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(sendFilters, 350);
  };
  search.addEventListener('input', debounced);
  author.addEventListener('input', debounced);
  branchSelect.addEventListener('change', sendFilters);
  branchFilter.addEventListener('input', () => {
    state.branchFilter = branchFilter.value.trim().toLowerCase();
    renderBranches();
  });

  function renderToolbar() {
    repoSelect.hidden = state.repos.length < 2;
    repoSelect.replaceChildren(...state.repos.map((r) => h('option', { value: r.root, text: r.name, selected: r.root === state.repo })));
    const option = (/** @type {string} */ value, /** @type {string} */ label) => h('option', { value, text: label, selected: (state.filters.branch || '') === value });
    const locals = state.refs.filter((r) => r.type === 'head');
    const remotes = state.refs.filter((r) => r.type === 'remote');
    const tags = state.refs.filter((r) => r.type === 'tag');
    branchSelect.replaceChildren(
      option('', 'All'),
      ...(state.headName ? [option('HEAD', 'HEAD (Current Branch)')] : []),
      h('optgroup', { label: 'Local' }, locals.map((r) => option(r.name, r.name))),
      h('optgroup', { label: 'Remote' }, remotes.map((r) => option(r.name, r.name))),
      h('optgroup', { label: 'Tags' }, tags.map((r) => option(r.name, r.name)))
    );
    if (document.activeElement !== search) search.value = state.filters.text || '';
    if (document.activeElement !== author) author.value = state.filters.author || '';
  }

  // ---------- Branches tree ----------
  /** Builds nested folders from slash-separated names. */
  function folders(/** @type {any[]} */ refs, /** @type {(r: any) => string} */ nameOf) {
    const root = { dirs: new Map(), leaves: [] };
    for (const ref of refs) {
      const parts = nameOf(ref).split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), leaves: [] });
        node = node.dirs.get(part);
      }
      node.leaves.push({ ref, label: parts[parts.length - 1] });
    }
    return root;
  }

  function matchesFilter(/** @type {any} */ ref) {
    return !state.branchFilter || ref.name.toLowerCase().includes(state.branchFilter);
  }

  function renderBranches() {
    const tree = [];
    const filtering = !!state.branchFilter;
    const node = (/** @type {string} */ key, /** @type {number} */ depth, /** @type {HTMLElement} */ label, /** @type {() => HTMLElement[]} */ children, open = true) => {
      const expanded = filtering || (state.expanded[key] ?? open);
      const row = h(
        'div',
        {
          class: 'tree-row group',
          style: `padding-left:${depth * 14 + 4}px`,
          onclick: () => {
            state.expanded[key] = !expanded;
            save();
            renderBranches();
          }
        },
        [icon('chevron', expanded ? 'twisty open' : 'twisty'), label]
      );
      tree.push(row);
      if (expanded) children();
      return row;
    };
    const leaf = (/** @type {any} */ ref, /** @type {string} */ label, /** @type {number} */ depth) => {
      const isFiltered = state.filters.branch === ref.name;
      const iconName = ref.type === 'tag' ? 'tag' : ref.current ? 'head' : ['main', 'master', 'develop'].includes(ref.name) ? 'star' : 'branch';
      const track = ref.type === 'head' && (ref.ahead || ref.behind) ? `${ref.ahead ? '↑' + ref.ahead : ''}${ref.behind ? ' ↓' + ref.behind : ''}` : '';
      const row = h(
        'div',
        {
          class: `tree-row leaf ${ref.current ? 'current' : ''} ${isFiltered ? 'filtered' : ''}`,
          style: `padding-left:${depth * 14 + 22}px`,
          title: `${ref.name}${ref.upstream ? ` → ${ref.upstream}` : ''}\nClick: go to the branch commit · Double-click: show only this branch · Right-click: actions`,
          onclick: () => reveal(ref.hash),
          ondblclick: () => {
            branchSelect.value = isFiltered ? '' : ref.name;
            sendFilters();
          },
          oncontextmenu: (/** @type {MouseEvent} */ e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'refMenu', name: ref.name, refType: ref.type, x: e.clientX, y: e.clientY });
          }
        },
        [icon(iconName, `ref-${ref.type} ${ref.current ? 'is-current' : ''} ${iconName === 'star' ? 'is-favorite' : ''}`), h('span', { class: 'name', text: label }), h('span', { class: 'track', text: track })]
      );
      tree.push(row);
    };
    const renderFolder = (/** @type {any} */ folder, /** @type {string} */ keyPrefix, /** @type {number} */ depth) => {
      for (const [name, sub] of [...folder.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        node(`${keyPrefix}/${name}`, depth, h('span', { class: 'label' }, [icon('folder'), h('span', { text: name })]), () => renderFolder(sub, `${keyPrefix}/${name}`, depth + 1));
      }
      for (const { ref, label } of folder.leaves.sort((/** @type {any} */ a, /** @type {any} */ b) => a.label.localeCompare(b.label))) {
        leaf(ref, label, depth);
      }
    };

    const locals = state.refs.filter((r) => r.type === 'head' && matchesFilter(r));
    const remotes = state.refs.filter((r) => r.type === 'remote' && matchesFilter(r));
    const tags = state.refs.filter((r) => r.type === 'tag' && matchesFilter(r)).sort((a, b) => b.date - a.date);
    const current = state.refs.find((r) => r.type === 'head' && r.current);

    if (current && matchesFilter(current)) {
      const row = h('div', { class: 'tree-row leaf current head-row', style: 'padding-left:4px', title: 'Current branch', onclick: () => reveal(current.hash) }, [
        icon('head', 'is-current'),
        h('span', { class: 'name', text: 'HEAD (Current Branch)' }),
        h('span', { class: 'track', text: current.name })
      ]);
      tree.push(row);
    } else if (!current && state.head && !filtering) {
      tree.push(h('div', { class: 'tree-row leaf current head-row', style: 'padding-left:4px', onclick: () => reveal(state.head) }, [icon('head', 'is-current'), h('span', { class: 'name', text: 'HEAD (detached)' }), h('span', { class: 'track', text: state.head.slice(0, 7) })]));
    }
    if (locals.length) {
      node('local', 0, h('span', { class: 'label', text: `Local` }), () => renderFolder(folders(locals, (r) => r.name), 'local', 1));
    }
    if (remotes.length) {
      node('remote', 0, h('span', { class: 'label', text: 'Remote' }), () => {
        const byRemote = new Map();
        for (const ref of remotes) byRemote.set(ref.remote, [...(byRemote.get(ref.remote) || []), ref]);
        for (const [remote, list] of byRemote) {
          node(`remote/${remote}`, 1, h('span', { class: 'label' }, [icon('cloud'), h('span', { text: remote })]), () =>
            renderFolder(folders(list, (r) => r.name.slice(remote.length + 1)), `remote/${remote}`, 2)
          );
        }
      });
    }
    if (tags.length || (!filtering && state.repo)) {
      node('tags', 0, h('span', { class: 'label', text: `Tags (${tags.length})` }), () => {
        tags.forEach((t) => leaf(t, t.name, 1));
        if (!tags.length) {
          // An empty repository section explains itself instead of disappearing.
          tree.push(
            h('div', { class: 'tree-row leaf hint', style: 'padding-left:22px', title: 'Tag the current commit', onclick: () => vscode.postMessage({ type: 'newTag' }) }, [
              icon('tag', 'ref-tag'),
              h('span', { class: 'name', text: 'No tags yet — New Tag…' })
            ])
          );
        }
      });
    }
    if (!tree.length) tree.push(h('div', { class: 'tree-empty', text: state.branchFilter ? 'No matching branches' : 'No branches' }));
    branchTree.replaceChildren(...tree);
  }

  // ---------- Commit table ----------
  /** Width that shows every lane of the loaded commits. */
  function fullGraphWidth() {
    let lanes = 1;
    for (const c of state.commits) lanes = Math.max(lanes, c.graph.width);
    return lanes * LANE + 8;
  }

  /** The user's width, or the full graph up to 24 lanes. */
  function graphColumnWidth() {
    return state.graphColumn ?? Math.min(fullGraphWidth(), 24 * LANE + 8);
  }

  /** @param {any} commit @param {number} width */
  function graphSvg(commit, width) {
    const svg = s('svg', { width, height: ROW, class: 'graph' });
    const x = (/** @type {number} */ lane) => 10 + lane * LANE;
    const mid = ROW / 2;
    for (const seg of commit.graph.segments) {
      const y1 = seg.half === 'top' ? 0 : mid;
      const y2 = seg.half === 'top' ? mid : ROW;
      const x1 = x(seg.from);
      const x2 = x(seg.to);
      const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      svg.append(s('path', { d, stroke: COLORS[seg.color % COLORS.length], 'stroke-width': 2, fill: 'none' }));
    }
    const isHead = commit.hash === state.head;
    const color = COLORS[commit.graph.color % COLORS.length];
    if (isHead) {
      svg.append(s('circle', { cx: x(commit.graph.lane), cy: mid, r: 6, fill: 'var(--bg)', stroke: color, 'stroke-width': 2 }));
      svg.append(s('circle', { cx: x(commit.graph.lane), cy: mid, r: 2.5, fill: color }));
    } else {
      svg.append(s('circle', { cx: x(commit.graph.lane), cy: mid, r: commit.parents.length > 1 ? 3.5 : 4.5, fill: color, stroke: 'var(--bg)', 'stroke-width': 1 }));
    }
    return svg;
  }

  function refLabels(/** @type {any} */ commit) {
    // A local branch and its upstream on the same commit share one label, as in JetBrains IDEs.
    const upstreamOf = (/** @type {string} */ name) => state.refs.find((r) => r.type === 'head' && r.name === name)?.upstream;
    const synced = new Set(commit.refs.filter((r) => r.type === 'head').map((r) => upstreamOf(r.name)).filter(Boolean));
    const order = ['head', 'remote', 'tag'];
    const refs = commit.refs
      .filter((/** @type {any} */ r) => !(r.type === 'remote' && synced.has(r.name)))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.current) - Number(a.current) || order.indexOf(a.type) - order.indexOf(b.type));
    const labels = [];
    const shown = refs.slice(0, 3);
    for (const ref of shown) {
      const upstream = ref.type === 'head' ? upstreamOf(ref.name) : undefined;
      const isSynced = upstream && commit.refs.some((/** @type {any} */ r) => r.type === 'remote' && r.name === upstream);
      const kind = ref.type === 'tag' ? 'Tag' : ref.type === 'remote' ? 'Remote branch' : 'Branch';
      labels.push(
        h('span', { class: `ref ref-${ref.type} ${ref.current ? 'is-current' : ''}`, title: `${kind} ${ref.name}${isSynced ? `\nIn sync with ${upstream}` : ''}` }, [
          icon(ref.type === 'tag' ? 'tag' : ref.current ? 'head' : ref.type === 'remote' ? 'cloud' : 'branch'),
          h('span', { text: ref.name }),
          ...(isSynced ? [icon('cloud', 'synced')] : [])
        ])
      );
    }
    if (refs.length > shown.length) {
      labels.push(h('span', { class: 'ref ref-more', text: `+${refs.length - shown.length}`, title: refs.slice(3).map((/** @type {any} */ r) => r.name).join('\n') }));
    }
    return labels;
  }

  function formatDate(/** @type {number} */ seconds) {
    const date = new Date(seconds * 1000);
    const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return `Today ${time}`;
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
    const sameYear = date.getFullYear() === today.getFullYear();
    return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })}, ${time}`;
  }

  /** @type {Map<number, HTMLElement>} */
  let rendered = new Map();
  let lastWidth = 0;
  function renderRows(force = false) {
    spacer.style.height = `${state.commits.length * ROW}px`;
    // Keep header columns aligned with the rows when the list shows a vertical scrollbar.
    header.style.paddingRight = `${rows.offsetWidth - rows.clientWidth}px`;
    const width = fullGraphWidth();
    if (force || width !== lastWidth) {
      applyColumns();
      rendered.forEach((el) => el.remove());
      rendered = new Map();
      lastWidth = width;
    }
    const first = Math.max(0, Math.floor(rows.scrollTop / ROW) - 10);
    const last = Math.min(state.commits.length, Math.ceil((rows.scrollTop + rows.clientHeight) / ROW) + 10);
    for (const [index, el] of rendered) {
      if (index < first || index >= last) {
        el.remove();
        rendered.delete(index);
      }
    }
    for (let i = first; i < last; i++) {
      const commit = state.commits[i];
      let el = rendered.get(i);
      if (!el) {
        el = h(
          'div',
          {
            class: 'row row-grid',
            style: `top:${i * ROW}px`,
            'data-hash': commit.hash,
            onmousedown: () => select(commit.hash),
            ondblclick: () => vscode.postMessage({ type: 'openAllChanges', hash: commit.hash }),
            oncontextmenu: (/** @type {MouseEvent} */ e) => {
              e.preventDefault();
              select(commit.hash);
              vscode.postMessage({ type: 'commitMenu', hash: commit.hash, x: e.clientX, y: e.clientY });
            }
          },
          [
            h('div', { class: 'graph-cell' }, [graphSvg(commit, width)]),
            h('div', { class: 'subject' }, [...refLabels(commit), h('span', { class: 'text', text: commit.subject, title: commit.subject })]),
            ...visibleColumns().map((column) =>
              h('div', {
                class: column,
                text: column === 'author' ? commit.author : column === 'date' ? formatDate(commit.date) : commit.shortHash,
                title: column === 'author' ? commit.author : undefined
              })
            )
          ]
        );
        rows.append(el);
        rendered.set(i, el);
      }
      el.classList.toggle('selected', commit.hash === state.selected);
      el.classList.toggle('head', commit.hash === state.head);
    }
    if (state.hasMore && !state.loadingMore && last >= state.commits.length - 5) {
      state.loadingMore = true;
      vscode.postMessage({ type: 'loadMore' });
    }
  }
  rows.addEventListener('scroll', () => renderRows());
  new ResizeObserver(() => renderRows()).observe(rows);

  function select(/** @type {string} */ hash, scroll = false) {
    if (state.selected !== hash) {
      state.selected = hash;
      state.details = undefined;
      state.containing = undefined;
      vscode.postMessage({ type: 'selectCommit', hash });
      renderDetails();
    }
    if (scroll) {
      const index = state.commits.findIndex((c) => c.hash === hash);
      if (index >= 0 && (index * ROW < rows.scrollTop || (index + 1) * ROW > rows.scrollTop + rows.clientHeight)) {
        rows.scrollTop = Math.max(0, index * ROW - rows.clientHeight / 3);
      }
    }
    renderRows();
  }

  function reveal(/** @type {string} */ hash) {
    if (state.commits.some((c) => c.hash === hash)) {
      select(hash, true);
      rows.focus();
    }
  }

  rows.addEventListener('keydown', (event) => {
    const index = state.commits.findIndex((c) => c.hash === state.selected);
    const page = Math.floor(rows.clientHeight / ROW);
    const target = { ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + page, PageUp: index - page, Home: 0, End: state.commits.length - 1 }[event.key];
    if (target !== undefined && state.commits.length) {
      event.preventDefault();
      select(state.commits[Math.max(0, Math.min(state.commits.length - 1, target))].hash, true);
    } else if (event.key === 'Enter' && state.selected) {
      vscode.postMessage({ type: 'openAllChanges', hash: state.selected });
    }
  });

  // ---------- Details ----------
  const STATUS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
  function renderDetails() {
    const details = state.details;
    if (!state.selected) {
      files.replaceChildren(h('div', { class: 'tree-empty', text: 'Select a commit to see its changes' }));
      message.replaceChildren();
      return;
    }
    if (!details || details.hash !== state.selected) {
      files.replaceChildren(h('div', { class: 'tree-empty', text: 'Loading…' }));
      message.replaceChildren();
      return;
    }
    const tree = [h('div', { class: 'files-header', text: `${details.changes.length} ${details.changes.length === 1 ? 'file' : 'files'} changed` })];
    const root = folders(details.changes, (c) => c.path);
    const renderFolder = (/** @type {any} */ folder, /** @type {number} */ depth, /** @type {string} */ prefix) => {
      for (const [name, sub] of [...folder.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        // Compress single-child folder chains: src/git/…
        let label = name;
        let node = sub;
        while (node.leaves.length === 0 && node.dirs.size === 1) {
          const [[childName, child]] = [...node.dirs];
          label += `/${childName}`;
          node = child;
        }
        tree.push(h('div', { class: 'tree-row group static', style: `padding-left:${depth * 14 + 4}px` }, [icon('folder'), h('span', { class: 'name', text: label }), h('span', { class: 'track', text: String(countLeaves(node)) })]));
        renderFolder(node, depth + 1, `${prefix}${label}/`);
      }
      for (const { ref: change, label } of folder.leaves.sort((/** @type {any} */ a, /** @type {any} */ b) => a.label.localeCompare(b.label))) {
        tree.push(
          h(
            'div',
            {
              class: `tree-row leaf file status-${change.status}`,
              style: `padding-left:${depth * 14 + 4}px`,
              title: `${change.path}\n${STATUS[change.status] || change.status}${change.origPath ? ` from ${change.origPath}` : ''}`,
              onclick: () => vscode.postMessage({ type: 'openDiff', hash: details.hash, path: change.path })
            },
            [h('span', { class: 'status-letter', text: change.status }), h('span', { class: 'name', text: label }), h('span', { class: 'track', text: change.origPath ? `← ${change.origPath}` : '' })]
          )
        );
      }
    };
    renderFolder(root, 0, '');
    files.replaceChildren(...tree);

    const [subject, ...body] = details.message.split('\n');
    const commit = state.commits.find((c) => c.hash === details.hash);
    message.replaceChildren(
      h('div', { class: 'msg-subject', text: subject }),
      ...(body.join('\n').trim() ? [h('div', { class: 'msg-body', text: body.join('\n').trim() })] : []),
      h('div', { class: 'meta' }, [
        h('span', { class: 'hash-full', text: details.hash.slice(0, 10), title: details.hash }),
        h('span', { text: ` ${details.author} <${details.email}>` })
      ]),
      h('div', { class: 'meta', text: `${formatDate(details.authorDate)}${details.committer !== details.author ? ` · committed by ${details.committer}` : ''}` }),
      ...(commit && commit.refs.length ? [h('div', { class: 'meta refs' }, refLabels({ refs: commit.refs }))] : []),
      h('div', {
        class: 'meta',
        text: state.containing ? (state.containing.length ? `In ${state.containing.length} ${state.containing.length === 1 ? 'branch' : 'branches'}: ${state.containing.slice(0, 8).join(', ')}${state.containing.length > 8 ? '…' : ''}` : 'Not in any branch') : 'Looking for branches…'
      })
    );
  }
  function countLeaves(/** @type {any} */ folder) {
    let count = folder.leaves.length;
    for (const sub of folder.dirs.values()) count += countLeaves(sub);
    return count;
  }

  // ---------- Context menu ----------
  function showMenu(/** @type {any} */ data) {
    menu.replaceChildren(
      ...data.items.map((/** @type {any} */ item) =>
        item.separator
          ? h('div', { class: 'menu-separator' })
          : h('div', {
              class: 'menu-item',
              text: item.label,
              onclick: () => {
                hideMenu();
                vscode.postMessage({ type: 'runMenu', id: item.id });
              }
            })
      )
    );
    menu.hidden = false;
    const { innerWidth, innerHeight } = window;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(data.x, innerWidth - rect.width - 4)}px`;
    menu.style.top = `${Math.max(4, Math.min(data.y, innerHeight - rect.height - 4))}px`;
  }
  function hideMenu() {
    menu.hidden = true;
  }
  /** A menu handled inside the webview, such as the column chooser. */
  function showLocalMenu(/** @type {number} */ x, /** @type {number} */ y, /** @type {{ label: string, run: () => void }[]} */ items) {
    menu.replaceChildren(
      ...items.map((item) =>
        h('div', {
          class: 'menu-item',
          text: item.label,
          onclick: () => {
            hideMenu();
            item.run();
          }
        })
      )
    );
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  }
  window.addEventListener('mousedown', (e) => {
    if (!menu.contains(/** @type {Node} */ (e.target))) hideMenu();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  window.addEventListener('blur', hideMenu);

  // ---------- Messages ----------
  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'loading':
        status.textContent = 'Loading…';
        break;
      case 'data': {
        document.body.classList.toggle('theme-git-colors', data.jetbrainsColors === false);
        const repoChanged = state.repo !== data.repo;
        Object.assign(state, {
          repos: data.repos,
          repo: data.repo,
          head: data.head,
          headName: data.headName,
          refs: data.refs,
          commits: data.commits,
          filters: data.filters || {},
          hasMore: data.hasMore,
          loadingMore: false
        });
        status.textContent = `${data.commits.length}${data.hasMore ? '+' : ''} commits`;
        empty.textContent = data.repos.length ? (data.commits.length ? '' : 'No commits match the filters') : 'No Git repository is open';
        empty.hidden = !!data.commits.length;
        if (repoChanged) rows.scrollTop = 0;
        renderToolbar();
        renderBranches();
        renderRows(true);
        const keep = state.selected && state.commits.some((c) => c.hash === state.selected);
        if (data.select) select(data.select, true);
        else if (!keep && state.commits.length) select(state.head && state.commits.some((c) => c.hash === state.head) ? state.head : state.commits[0].hash, true);
        else if (!state.commits.length) {
          state.selected = undefined;
          renderDetails();
        }
        break;
      }
      case 'details':
        if (data.hash === state.selected) {
          state.details = data;
          renderDetails();
        }
        break;
      case 'containing':
        if (data.hash === state.selected) {
          state.containing = data.branches;
          renderDetails();
        }
        break;
      case 'menu':
        showMenu(data);
        break;
    }
  });

  renderDetails();
  vscode.postMessage({ type: 'ready' });
})();
