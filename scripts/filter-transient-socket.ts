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
// Capture the real process.on BEFORE patching: resolving `process.on` at call
// time would re-enter `patchedOn` forever (mutual tail recursion => omp hangs
// at 100% CPU the moment it registers any signal handler).
const realOn = process.on.bind(process);
const origOn: LooseOn = (ev, fn, ...rest) => Reflect.apply(realOn, process, [ev, fn, ...rest]);
Object.defineProperty(process, "on", {
  configurable: true,
  value: function patchedOn(this: typeof process, ev: string, fn: Handler, ...rest: unknown[]): unknown {
    if (ev === "uncaughtException" && typeof fn === "function") {
      const wrapped = (err: Error, ...inner: unknown[]): void => {
        const msg = String(err?.message ?? "");
        const stack = err?.stack ?? "";
        if (msg === "ECONNREFUSED: connection refused, recv" && !stack.includes("\n")) {
          return;
        }
        return fn(err, ...inner);
      };
      return origOn("uncaughtException", wrapped as Handler, ...rest);
    }
    return origOn(ev, fn as Handler, ...rest);
  },
});
