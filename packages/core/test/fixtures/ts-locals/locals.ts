// Fixture for kind='local' symbol extraction.
//
// foo declares two top-level locals (`bar`, `baz`) and one nested local
// (`nested`) which the extractor should NOT promote (depth > 1). It also
// destructures (`pair`) which we deliberately skip for now.
export function foo(): number {
  const bar = 1;
  let baz = bar;
  if (baz > 0) {
    const nested = baz + 1;
    return nested;
  }
  const { x, y } = { x: 1, y: 2 };
  return baz + x + y;
}

// quux passes a local into a callee — exercises the arg-binding-to-local
// resolution path.
export function quux(): number {
  const seed = compute();
  return consume(seed);
}

export function compute(): number {
  return 42;
}

export function consume(n: number): number {
  return n + 1;
}
