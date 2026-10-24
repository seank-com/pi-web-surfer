import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
const root = await realpath(await mkdtemp(join(tmpdir(), "web-native-policy-")));
process.chdir(root);
process.env.HOME = root;
process.env.TMPDIR = join(root, "tmp");
await mkdir(process.env.TMPDIR, { mode: 0o700 });
const host = process.env.PI_CODING_AGENT_PACKAGE!;
const datastore = process.env.DATASTORE_PACKAGE!;
assert.ok(host && datastore, "explicit host and datastore package required");
const sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
const ai = await import(
	pathToFileURL(
		join(
			dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(host, "package.json")))!),
			"dist/index.js",
		),
	).href
);
const entry = process.env.WEB_SURFER_ENTRY ?? new URL("../../src/index.ts", import.meta.url).href;
try {
	for (const order of ["web-first", "datastore-first"]) {
		const cwd = join(root, order),
			profile = join(root, order + "-profile");
		await mkdir(cwd);
		await mkdir(profile);
		process.env.PI_CODING_AGENT_DIR = profile;
		await mkdir(join(cwd, "notes"));
		await writeFile(join(cwd, "input.txt"), "Native fixture source bytes");
		const configDir = join(cwd, ".pi/markdown-datastore");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		const config = {
			schemaVersion: 1,
			defaults: { maxResultBytes: 4096, maxResultLines: 100, operationTimeoutMs: 3000 },
			qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" },
			stores: {
				fixture: {
					root: "notes",
					include: ["**/*.md"],
					exclude: [],
					maxFileBytes: 4096,
					search: { defaultMode: "lexical", qmdCollection: "fixture" },
				},
			},
		};
		await writeFile(join(configDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
		const arrived = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const slow = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.write("unfinished");
			arrived.resolve();
			res.on("close", () => closed.resolve());
		});
		await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
		const slowUrl = `http://127.0.0.1:${(slow.address() as any).port}/`;
		const f: any = { disabled: false, results: [], errors: [], settled: 0, calls: 0 };
		(globalThis as any).webPolicyFixture = f;
		const web = join(cwd, "web.ts"),
			data = join(cwd, "data.ts");
		await writeFile(
			web,
			`import {createWebSurferExtension} from ${JSON.stringify(entry)};export default function(pi){const f=globalThis.webPolicyFixture;if(f.disabled)return;pi.on('tool_result',e=>{if(e.toolName==='web_fetch')f.results.push(e);});pi.on('agent_settled',()=>{f.settled++;});createWebSurferExtension()(pi);}`,
		);
		await writeFile(
			data,
			`import {createMarkdownDatastoreExtension} from ${JSON.stringify(pathToFileURL(join(datastore, "dist/index.js")).href)};export default function(pi){if(globalThis.webPolicyFixture.disabled)return;createMarkdownDatastoreExtension({projectRoot:${JSON.stringify(cwd)},configPath:${JSON.stringify(join(configDir, "config.json"))}})(pi);}`,
		);
		const modelRuntime = await sdk.ModelRuntime.create({
			authPath: join(profile, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(profile, "models.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const provider = "web-policy-fixture";
		const model = {
			id: "fixture",
			name: "Fixture",
			api: "openai-completions",
			provider,
			baseUrl: "http://fixture.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		};
		modelRuntime.registerProvider(provider, {
			api: model.api,
			apiKey: "synthetic-only",
			baseUrl: model.baseUrl,
			models: [model],
			streamSimple: () => {
				const stream = ai.createAssistantMessageEventStream();
				void (async () => {
					const call = ++f.calls;
					assert.ok(call <= 6, "unexpected model request");
					let content: any[],
						reason = "stop";
					if (call <= 2 || call === 4 || call === 6) {
						const args =
							call === 6
								? { url: slowUrl }
								: call === 1
									? { path: join(cwd, "input.txt"), saveTo: "out/accepted.txt" }
									: call === 2
										? { artifactId: f.results[0]?.details?.artifactId, saveTo: "notes/refused.txt" }
										: { path: join(cwd, "input.txt"), refresh: true };
						content = [{ type: "toolCall", id: `policy-${call}`, name: "web_fetch", arguments: args }];
						reason = "toolUse";
					} else content = [{ type: "text", text: "Native policy checks complete." }];
					const message = {
						role: "assistant",
						content,
						api: model.api,
						provider,
						model: model.id,
						usage: {
							input: 10,
							output: 10,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 20,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: reason,
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason, message });
					stream.end();
				})().catch((error) => {
					f.errors.push(String(error));
					stream.push({
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							content: [],
							api: model.api,
							provider,
							model: model.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "error",
							errorMessage: String(error),
							timestamp: Date.now(),
						},
					});
					stream.end();
				});
				return stream;
			},
		});
		let session: any;
		try {
			const settingsManager = sdk.SettingsManager.inMemory(
				{ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
				{ projectTrusted: true },
			);
			const resourceLoader = new sdk.DefaultResourceLoader({
				cwd,
				agentDir: profile,
				settingsManager,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: order === "web-first" ? [web, data] : [data, web],
			});
			await resourceLoader.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			({ session } = await sdk.createAgentSession({
				cwd,
				agentDir: profile,
				settingsManager,
				resourceLoader,
				modelRuntime,
				model,
				sessionManager: sdk.SessionManager.inMemory(cwd),
			}));
			await session.bindExtensions({
				onError: (e: unknown) => f.errors.push(String(e)),
				uiContext: { setStatus() {} },
			});
			await session.prompt("Exercise the initial synthetic policy checks.");
			config.stores.fixture.root = join(process.env.TMPDIR!, "web-surfer");
			await writeFile(join(configDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
			await session.reload();
			await session.prompt("Exercise the changed effective ownership.");
			assert.deepEqual(f.errors, []);
			assert.equal(f.results.length, 3, JSON.stringify(f.results));
			assert.equal(f.results[0].details.ok, true, JSON.stringify(f.results[0]));
			assert.equal(f.results[1].details.savedPath, undefined);
			assert.ok(f.results[1].details.warnings.some((w: any) => w.code === "destination_blocked"));
			assert.equal(f.results[2].details.code, "destination_blocked", JSON.stringify(f.results[2]));
			assert.equal(await readFile(join(cwd, "out/accepted.txt"), "utf8"), "Native fixture source bytes");
			await assert.rejects(readFile(join(cwd, "notes/refused.txt")));
			config.stores.fixture.root = "notes";
			await writeFile(join(configDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
			await session.reload();
			const running = session.prompt("Fetch the cancellable local fixture.");
			await arrived.promise;
			await session.abort();
			await running;
			await closed.promise;
			assert.equal(f.results.at(-1).details.code, "cancelled");
			assert.equal(f.results.at(-1).details.artifactId, undefined, "Stop does not publish an unfinished response");
			assert.equal(f.calls, 6, "abort does not start a follow-up model request");
			console.log("PASS native public policy " + order + " and actual Stop cancellation");
		} finally {
			if (session) {
				await session.abort();
				f.disabled = true;
				await session.reload();
				session.dispose();
			}
			modelRuntime.unregisterProvider(provider);
			slow.closeAllConnections();
			await new Promise<void>((resolve) => slow.close(() => resolve()));
		}
	}
} finally {
	delete (globalThis as any).webPolicyFixture;
	await rm(root, { recursive: true, force: true });
}
