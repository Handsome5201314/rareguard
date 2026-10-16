import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { familyServerOptions } from "../src/server/config.js";
import { startFamilyServer } from "../src/server/http.js";

test("standalone config uses only its launch directory and explicitly configured web root", () => {
  const cwd = resolve(tmpdir(), "synthetic-bingcheng-config");
  assert.deepEqual(familyServerOptions({}, cwd), {
    port: 7870, dataDir: join(cwd, "family-data"), publicOrigin: undefined, proxyToken: undefined,
  });
  const configured = familyServerOptions({ FAMILY_DATA_DIR: "private", FAMILY_PORT: "17891", FAMILY_WEB_ROOT: "web" }, cwd);
  assert.equal(configured.dataDir, join(cwd, "private"));
  assert.equal(configured.webRoot, join(cwd, "web"));
  assert.equal(configured.port, 17891);
  assert.equal(familyServerOptions({ FAMILY_WEB_ROOT: "environment-web" }, cwd, ["--web-root", "cli-web"]).webRoot, join(cwd, "cli-web"));
});

test("invalid launch configuration fails before storage is opened", () => {
  for (const value of ["", "0", "-1", "65536", "NaN", "7870.5"]) assert.throws(() => familyServerOptions({ FAMILY_PORT: value }));
  assert.throws(() => familyServerOptions({ FAMILY_DATA_DIR: " " }));
  assert.throws(() => familyServerOptions({ FAMILY_WEB_ROOT: " " }));
  for (const args of [["--web-root"], ["--web-root", ""], ["--unknown"], ["--web-root", "web", "extra"]]) {
    assert.throws(() => familyServerOptions({}, undefined, args));
  }
});

test("API-only mode exposes authenticated interfaces without requiring a frontend build", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bingcheng-api-only-"));
  let app: Awaited<ReturnType<typeof startFamilyServer>> | undefined;
  t.after(async () => { try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  app = await startFamilyServer({ dataDir: join(dir, "private"), port: 0 });
  assert.equal((await fetch(app.url + "/healthz")).status, 200);
  const page = await fetch(app.url + "/");
  assert.equal(page.status, 404);
  assert.equal((await page.json() as { error: { code: string } }).error.code, "STATIC_WEB_DISABLED");
  assert.equal((await fetch(app.url + "/api/family/children")).status, 401);
  assert.equal((await fetch(app.url + "/mcp/family")).status, 401);
});

test("optional static hosting serves explicit SPA and assets; missing build fails before creating data", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bingcheng-static-"));
  let app: Awaited<ReturnType<typeof startFamilyServer>> | undefined;
  t.after(async () => { try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  await assert.rejects(startFamilyServer({ dataDir: join(dir, "unopened"), port: 0, webRoot: join(dir, "missing") }));
  assert.deepEqual(await readdir(dir), []);
  const webRoot = join(dir, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Synthetic family app</title>");
  await writeFile(join(webRoot, "app.js"), "globalThis.synthetic = true;");
  app = await startFamilyServer({ dataDir: join(dir, "private"), port: 0, webRoot });
  assert.match(await (await fetch(app.url + "/share/synthetic")).text(), /Synthetic family app/);
  const asset = await fetch(app.url + "/app.js");
  assert.match(asset.headers.get("content-type")!, /javascript/);
  assert.equal(await asset.text(), "globalThis.synthetic = true;");
  assert.equal(await (await fetch(app.url + "/", { method: "HEAD" })).text(), "");
  assert.equal((await fetch(app.url + "/missing.js")).status, 404);
  assert.equal((await fetch(app.url + "/api/family/children")).status, 401);
});

test("real HTTP entry loads launch-directory environment and creates an isolated database", { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "bingcheng-entry-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done, reject) => socket.close(error => error ? reject(error) : done()));
  await writeFile(join(dir, ".env.family-public"), `FAMILY_PORT=${port}\nFAMILY_DATA_DIR=private\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FAMILY_")));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server/main.js", import.meta.url))], {
    cwd: dir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-4096); });
  child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-4096); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  for (let attempt = 0; !output.includes("独立 API 模式"); attempt++) {
    assert.ok(attempt < 100 && child.exitCode === null, "isolated entry did not start: " + output);
    await delay(50);
  }
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { product: string }).product, "family-timeline");
  assert.ok((await readdir(dir)).includes("private"));
  assert.ok(!(await readdir(dir)).includes("family-data"));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/family/children`)).status, 401);
});
