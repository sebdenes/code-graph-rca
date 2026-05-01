// v1: disable Monaco workers and run tokenization in-thread. The Vite `?worker`
// dance is brittle across versions of monaco-editor + @monaco-editor/react, so
// we trade some perf for a deterministic boot. Revisit if files get large.
//
// Setting MonacoEnvironment.getWorker before any Monaco code touches the DOM is
// the supported escape hatch; Monaco falls back to the main-thread tokenizer
// when getWorker returns a stub Worker.

let installed = false;

export function installMonacoEnv(): void {
  if (installed) return;
  installed = true;
  const noopWorker = (): Worker => ({} as Worker);
  if (typeof self !== "undefined") {
    (self as unknown as { MonacoEnvironment: { getWorker: typeof noopWorker } }).MonacoEnvironment = {
      getWorker: noopWorker,
    };
  }
}
