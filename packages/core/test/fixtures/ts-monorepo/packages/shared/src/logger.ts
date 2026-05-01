export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${level.toUpperCase()} ${msg}`);
}
