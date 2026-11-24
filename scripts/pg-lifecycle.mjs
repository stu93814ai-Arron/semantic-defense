import { rmSync } from "node:fs";

/** postgres 脫離 with-pg 的程序群組，GNU timeout 的 TERM 才不會先把它關機。 */
export function spawnDetachedPostmaster(orig) {
  return function spawnDetached(command, args, options) {
    const name = String(command).split("/").pop();
    const flags = Array.isArray(args) ? args : [];
    const postmaster = name === "postgres" && flags.includes("-D");
    const opts = postmaster ? { ...options, detached: true } : options;
    return orig.call(this, command, args, opts);
  };
}

/** embedded-postgres 的 exit-hook 會在 TERM 當下 pg.stop()，快照還沒寫完。 */
export function dropSigtermListeners() {
  process.removeAllListeners("SIGTERM");
}

function childGone(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

export function waitChild(child, ms) {
  if (childGone(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

export async function stopAndRemove(stop, dir) {
  await stop().catch(() => {});
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export function armClusterTerm(ctx) {
  let started = false;
  process.on("SIGTERM", () => {
    if (started) return;
    started = true;
    void (async () => {
      await waitChild(ctx.getChild(), 3000);
      await ctx.shutdown();
      ctx.exit(143);
    })();
  });
}
