/**
 * Loaded with `--import` for every test process (see package.json "test").
 * Forces test mode and gives the whole process a disposable DB and uploads dir,
 * so any test that reaches the DB layer, even by accident, uses temp storage.
 * The config guard makes the real data/ locations unreachable in test mode.
 */
import { withTempEnv } from "./harness";

process.env.STWEG_TEST = "1";
const env = withTempEnv();
process.on("exit", () => {
  try {
    env.cleanup();
  } catch {
    // never throw from an exit handler
  }
});
