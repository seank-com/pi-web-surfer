import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const files = readdirSync("tests").filter(name => name.endsWith(".test.ts") && name !== "package.test.ts");
const result = spawnSync(process.execPath, ["--test", ...files.map(name => `tests/${name}`)], {
  stdio: "inherit",
  env: { ...process.env, PI_CODING_AGENT_PACKAGE: process.env.PI_CODING_AGENT_PACKAGE ?? host },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
