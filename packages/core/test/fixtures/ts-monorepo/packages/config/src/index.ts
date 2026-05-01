export const HASH_ROUNDS = 12;

export function getEnv(k: string): string | undefined {
  return process.env[k];
}
