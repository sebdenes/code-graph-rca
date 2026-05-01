import { foo, Greeter } from "./a.js";

export function bar(): number {
  const g = new Greeter();
  g.greet("world");
  return foo(41);
}
