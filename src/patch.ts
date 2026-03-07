import { App, TFile } from 'obsidian';

// ── Constants ────────────────────────────────────────────────────────────────

const PATCH_FLAG = '__localGraphTagLinksPatch';

// ── Internal type shapes (runtime, not from the public API) ──────────────────

interface InternalNode {
  type: string; // '' | 'tag' | 'attachment' | 'unresolved' | …
  links: Record<string, boolean>; // adjacency: target id → true
  color?: unknown;
}

interface GraphData {
  nodes: Record<string, InternalNode>;
  weights?: Record<string, number>; // weight ∝ closeness to center; 0 = max depth reached
}

// ── Tag helpers ───────────────────────────────────────────────────────────────

function normalizeTag(raw: string): string {
  const t = raw.trim();
  return (t.startsWith('#') ? t : '#' + t).toLowerCase();
}

function getFileTags(cache: any): Set<string> {
  const out = new Set<string>();
  for (const ref of cache?.tags ?? []) {
    if (ref?.tag) out.add(normalizeTag(ref.tag));
  }
  const fm: unknown = cache?.frontmatter?.tags;
  if (Array.isArray(fm)) {
    for (const t of fm) {
      if (typeof t === 'string' && t.trim()) out.add(normalizeTag(t));
    }
  } else if (typeof fm === 'string' && fm.trim()) {
    out.add(normalizeTag(fm));
  }
  return out;
}

// ── Backlink indices ─────────────────────────────────────────────────────────

/** One-pass O(links) precomputation: backlinkIdx[target] = [source, …] */
function buildBacklinkIndex(app: App): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const [src, targets] of Object.entries(
    app.metadataCache.resolvedLinks,
  )) {
    for (const tgt of Object.keys(targets)) {
      (idx[tgt] ??= []).push(src);
    }
  }
  return idx;
}

/**
 * Reverse index for unresolved links: linkText → [source file paths].
 * Needed to find which existing files reference a non-existing note.
 */
function buildUnresolvedBacklinkIndex(app: App): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const [src, targets] of Object.entries(
    app.metadataCache.unresolvedLinks as Record<string, Record<string, number>>,
  )) {
    for (const tgt of Object.keys(targets)) {
      (idx[tgt] ??= []).push(src);
    }
  }
  return idx;
}

// ── Core injection ────────────────────────────────────────────────────────────

/**
 * Continues Obsidian's local-graph BFS through tag nodes, which Obsidian
 * deliberately blocks with `xG = {tag: true}`.
 *
 * Queue semantics
 * ───────────────
 *  • tag  node  → inject sibling files that share that tag
 *  • file node  → expand forelinks, backlinks, and own tags
 *
 * Depth contract (mirrors Obsidian's weight scheme):
 *   center = 30, step = 30 / localJumps
 *   canSpawn = (w > 0)  →  only nodes with remaining budget create NEW nodes
 *
 * Crucially, even when canSpawn is false, edges to ALREADY-PRESENT nodes are
 * always drawn — so depth-boundary nodes never have missing connections.
 */
function injectTagLinks(
  app: App,
  options: Record<string, any>,
  data: GraphData,
): void {
  const { nodes, weights } = data;
  const jumps = Math.max(1, options.localJumps ?? 1);
  const step = 30 / jumps;
  const useFore = options.localForelinks !== false; // default true
  const useBack = options.localBacklinks !== false; // default true
  const useTags = options.showTags === true;
  const showUnresolved = options.hideUnresolved !== true; // default true (show them)

  const inGraph = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(nodes, id);

  const backlinkIdx = useBack
    ? buildBacklinkIndex(app)
    : ({} as Record<string, string[]>);
  const unresolvedBacklinkIdx =
    useBack && showUnresolved
      ? buildUnresolvedBacklinkIndex(app)
      : ({} as Record<string, string[]>);

  interface QItem {
    id: string;
    w: number;
  }
  const queue: QItem[] = [];
  const queued = new Set<string>();

  /** Enqueue once — prevents re-processing the same node. */
  function enqueue(id: string, w: number): void {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push({ id, w });
  }

  // Seed: every tag node Obsidian placed in the subgraph
  for (const id of Object.keys(nodes)) {
    if (nodes[id].type === 'tag') enqueue(id, weights?.[id] ?? 0);
  }

  while (queue.length > 0) {
    const { id, w } = queue.shift()!;
    const node = nodes[id];
    if (!node) continue;

    const childW = Math.max(0, w - step);
    const canSpawn = w > 0; // allowed to create NEW nodes?

    // ── Tag node: inject sibling files ────────────────────────────────────
    if (node.type === 'tag') {
      if (!canSpawn) continue; // at depth limit — nothing to inject

      const tagNorm = id.toLowerCase();

      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        if (!cache || !getFileTags(cache).has(tagNorm)) continue;

        if (inGraph(file.path)) {
          nodes[file.path].links[id] = true;
        } else {
          nodes[file.path] = { type: '', links: { [id]: true } };
          if (weights) weights[file.path] = childW;
          enqueue(file.path, childW);
        }
      }

      // ── File node (injected by us): expand its neighbourhood ──────────────
    } else {
      // Forelinks — pages this note links to
      if (useFore) {
        const outgoing = app.metadataCache.resolvedLinks[id] ?? {};
        for (const tgt of Object.keys(outgoing)) {
          if (inGraph(tgt)) {
            // Target already in graph — always draw the edge
            node.links[tgt] = true;
          } else if (canSpawn) {
            if (app.vault.getAbstractFileByPath(tgt) instanceof TFile) {
              nodes[tgt] = { type: '', links: {} };
              if (weights) weights[tgt] = childW;
              node.links[tgt] = true;
              enqueue(tgt, childW);
            }
          }
        }
      }

      // Unresolved forelinks — links to non-existent notes
      // These live in unresolvedLinks, not resolvedLinks, with type 'unresolved'
      if (useFore && showUnresolved) {
        const unresolved =
          (
            app.metadataCache.unresolvedLinks as Record<
              string,
              Record<string, number>
            >
          )[id] ?? {};
        for (const tgt of Object.keys(unresolved)) {
          if (inGraph(tgt)) {
            node.links[tgt] = true;
          } else if (canSpawn) {
            nodes[tgt] = { type: 'unresolved', links: {} };
            if (weights) weights[tgt] = childW;
            node.links[tgt] = true;
            if (useBack) enqueue(tgt, childW); // may have backlinks
          }
        }
      }

      // Backlinks — pages that link to this note
      if (useBack) {
        const backSources =
          node.type === 'unresolved'
            ? (unresolvedBacklinkIdx[id] ?? []) // link-text reverse index
            : (backlinkIdx[id] ?? []); // file-path reverse index

        for (const src of backSources) {
          if (inGraph(src)) {
            nodes[src].links[id] = true;
          } else if (canSpawn) {
            if (app.vault.getAbstractFileByPath(src) instanceof TFile) {
              nodes[src] = { type: '', links: { [id]: true } };
              if (weights) weights[src] = childW;
              enqueue(src, childW);
            }
          }
        }
      }

      // Tags of the injected file (mirror Obsidian's showTags behaviour)
      if (useTags) {
        const cache = app.metadataCache.getCache(id);
        if (cache) {
          for (const tagNorm of getFileTags(cache)) {
            // Find a matching tag node already in the graph (case-insensitive)
            const existingTagId = Object.keys(nodes).find(
              (k) => nodes[k].type === 'tag' && k.toLowerCase() === tagNorm,
            );
            if (existingTagId) {
              node.links[existingTagId] = true;
            } else if (canSpawn) {
              nodes[tagNorm] = { type: 'tag', links: {} };
              if (weights) weights[tagNorm] = childW;
              node.links[tagNorm] = true;
              enqueue(tagNorm, childW);
            }
          }
        }
      }
    }
  }
}

// ── Prototype patch ───────────────────────────────────────────────────────────

/**
 * Patches WG.prototype.render once (the GraphEngine shared by both graph views).
 * Returns a cleanup function that restores the original.
 */
export function patchGraphEngine(app: App, engine: any): (() => void) | null {
  const proto: any = engine?.constructor?.prototype;
  if (!proto?.render || proto[PATCH_FLAG]) return null;

  const originalRender = proto.render as (this: any) => number;
  proto[PATCH_FLAG] = true;

  proto.render = function (this: any): number {
    const opts: Record<string, any> = this.options ?? {};
    const isLocal = this.view?.getViewType?.() === 'localgraph';

    if (!isLocal || !opts.localFile || !opts.showTags) {
      return originalRender.call(this);
    }

    // Temporarily wrap renderer.setData to intercept the final subgraph
    // data right before it reaches the renderer.
    const renderer = this.renderer;
    const originalSetData = renderer.setData as (
      this: any,
      data: GraphData,
    ) => void;

    renderer.setData = function (this: any, data: GraphData): void {
      injectTagLinks(app, opts, data);
      return originalSetData.call(this, data);
    };

    try {
      return originalRender.call(this);
    } finally {
      renderer.setData = originalSetData;
    }
  };

  return (): void => {
    proto.render = originalRender;
    delete proto[PATCH_FLAG];
  };
}
