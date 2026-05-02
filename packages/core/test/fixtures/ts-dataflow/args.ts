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
