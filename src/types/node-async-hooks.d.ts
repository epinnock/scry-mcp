// Minimal types for the one Node API this Worker uses (nodejs_compat is on in
// wrangler.jsonc). @types/node is not a dependency: it would pull Node globals
// into a Workers project.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
