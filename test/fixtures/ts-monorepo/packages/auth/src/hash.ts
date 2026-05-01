import { HASH_ROUNDS } from "@fixture/config";

export function hashPassword(s: string): string {
  let h = 0;
  for (let r = 0; r < HASH_ROUNDS; r++) {
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i) + r) | 0;
    }
  }
  return h.toString(16);
}
