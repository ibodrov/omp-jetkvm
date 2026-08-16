/**
 * omp dies (exit 2, "Operation aborted") on transient stackless socket errors
 * from Bun-native IO pools ("ECONNREFUSED: connection refused, recv"). They
 * are harmless — sessions complete when not treated as fatal. This preload
 * wraps omp's uncaughtException handler so exactly that error shape (no
 * stack) is swallowed; everything else passes through untouched.
 * Install via `preload = [...]` in the bunfig.toml of the directory you run
 * omp from.
 */
type Handler = (...args: unknown[]) => void;
type LooseOn = (ev: string, fn: Handler, ...rest: unknown[]) => unknown;
const origOn: LooseOn = (ev, fn, ...rest) => Reflect.apply(process.on, process, [ev, fn, ...rest]);
Object.defineProperty(process, "on", {
  configurable: true,
  value: function patchedOn(this: typeof process, ev: string, fn: Handler, ...rest: unknown[]): unknown {
    if (ev === "uncaughtException" && typeof fn === "function") {
      const wrapped = (err: Error, ...inner: unknown[]): void => {
        const msg = String(err?.message ?? "");
        const stack = err?.stack ?? "";
        if (/ECONNREFUSED/.test(msg) && !stack.includes("\n")) {
          try {
            require("node:fs").appendFileSync("/tmp/omp-socket-filter.log", `[swallowed] ${msg}\n`);
          } catch {
            // logging best-effort
          }
          return;
        }
        return fn(err, ...inner);
      };
      return origOn("uncaughtException", wrapped as Handler, ...rest);
    }
    return origOn(ev, fn as Handler, ...rest);
  },
});
