import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO = process.cwd();

describe("T-A5 package.json scripts: localhost only, telemetry off, port unchanged (3456; D-11 not approved)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const name of ["dev", "start"]) {
    it(`${name} binds 127.0.0.1:3456 with NEXT_TELEMETRY_DISABLED=1`, () => {
      const script = pkg.scripts[name];
      assert.match(script, /(^|\s)NEXT_TELEMETRY_DISABLED=1\s/);
      assert.match(script, /\s-H 127\.0\.0\.1(\s|$)/);
      assert.match(script, /\s-p 3456(\s|$)/);
      assert.doesNotMatch(script, /0\.0\.0\.0|-H\s+::/);
    });
  }
  it("test script runs in test mode through the harness setup", () => {
    assert.match(pkg.scripts.test, /STWEG_TEST=1/);
    assert.match(pkg.scripts.test, /--import \.\/src\/test\/setup\.ts/);
  });
});

