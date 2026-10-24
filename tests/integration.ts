import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
test(
	"packed web tools consume actual datastore policy through native SDK in both load orders",
	{ timeout: 90000 },
	async (t) => {
		assert.ok(process.env.DATASTORE_TARBALL, "DATASTORE_TARBALL must select an explicit candidate");
		const consumer = await mkdtemp(join(tmpdir(), "web-packed-policy-"));
		t.after(() => rm(consumer, { recursive: true, force: true }));
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--pack-destination", consumer], { cwd: root, encoding: "utf8" }),
		)[0];
		await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
		execFileSync(
			"npm",
			[
				"install",
				"--cache",
				join(consumer, "npm-cache"),
				"--ignore-scripts",
				"--legacy-peer-deps",
				"--no-audit",
				"--no-fund",
				join(consumer, packed.filename),
				resolve(process.env.DATASTORE_TARBALL!),
			],
			{ cwd: consumer, stdio: "pipe", timeout: 45000 },
		);
		await writeFile(
			join(consumer, "native-policy-probe.ts"),
			await readFile(new URL("./fixtures/native-policy-probe.ts", import.meta.url), "utf8"),
		);
		await mkdir(join(consumer, "home"));
		const host = resolve(
			process.env.PI_CODING_AGENT_PACKAGE ?? join(root, "node_modules/@earendil-works/pi-coding-agent"),
		);
		const output = execFileSync(process.execPath, [join(consumer, "native-policy-probe.ts")], {
			cwd: consumer,
			env: {
				...process.env,
				HOME: join(consumer, "home"),
				PI_CODING_AGENT_DIR: join(consumer, "profile"),
				PI_CODING_AGENT_PACKAGE: host,
				DATASTORE_PACKAGE: join(consumer, "node_modules/@seank/pi-markdown-datastore"),
				WEB_SURFER_ENTRY: pathToFileURL(join(consumer, "node_modules/@seank/pi-web-surfer/dist/index.js")).href,
			},
			encoding: "utf8",
			timeout: 30000,
		});
		assert.match(output, /PASS native public policy web-first/);
		assert.match(output, /PASS native public policy datastore-first/);
	},
);
