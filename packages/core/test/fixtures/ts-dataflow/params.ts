// Fixture for params extraction tests.
export function foo(a: string, b: number = 5): string {
  return `${a}:${b}`;
}

export function noParams(): void {
  return;
}

export const arrowAdd = (x: number, y: number): number => x + y;

export class Greeter {
  greet(name: string, loud?: boolean): string {
    return loud ? name.toUpperCase() : name;
  }
}
