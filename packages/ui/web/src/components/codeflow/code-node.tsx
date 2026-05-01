/**
 * Stub kept for backward compatibility with previous build artifacts that
 * referenced the now-removed React Flow code-card component. The current
 * Graph view uses Cytoscape (see `views/graph/cy-canvas.tsx`) and renders
 * compact dots, not React component cards.
 *
 * This file intentionally exports an empty component plus the symbolic
 * type names the older code path used. Nothing here is rendered.
 */

export interface CodeNodeData {
  // legacy shape — unused
  symbol: unknown;
  filePath: string;
}

export function CodeNode(): null {
  return null;
}

export function PhantomNode(): null {
  return null;
}
