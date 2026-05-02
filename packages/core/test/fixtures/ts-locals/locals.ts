// Fixture for kind='local' symbol extraction.
//
// foo exercises depth-1 + nested-block + object-destructured locals — all
// promoted to kind='local' as of the loop/destructure expansion.
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

// loops covers all three for-loop shapes plus a Python-style for-in and
// nested-loop locals (inner const). The test asserts the iter vars from each
// loop appear as kind='local' with parent=loops.
export function loops(items: number[], obj: Record<string, number>): number {
  let acc = 0;
  for (const ofVar of items) {
    acc += ofVar;
  }
  for (const inKey in obj) {
    acc += obj[inKey] ?? 0;
  }
  for (let cIdx = 0; cIdx < items.length; cIdx++) {
    const inner = items[cIdx]!;
    acc += inner;
  }
  return acc;
}

// Array destructuring with rest. Each element + the rest binding becomes its
// own kind='local'.
export function arrayDestr(arr: number[]): number {
  const [first, second, ...rest] = arr;
  return (first ?? 0) + (second ?? 0) + rest.length;
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
