// Fixture for arg-bindings extraction tests.
export function bar(): string {
  const user = { id: "u1", name: "alice" };
  return target(user.id, "literal", computeX());
}

export function target(id: string, label: string, x: number): string {
  return `${id}-${label}-${x}`;
}

export function computeX(): number {
  return 42;
}

// localCarrier exercises identifier-arg → local-symbol resolution: the
// identifier `payload` is a kind='local' in the caller's body, and the
// arg-binding for relay(payload) should resolve to that local row.
export function localCarrier(): string {
  const payload = "hello";
  return relay(payload);
}

export function relay(s: string): string {
  return s;
}
