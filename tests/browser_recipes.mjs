// Real Chromium smoke test, with a local fixture API (no GPU/network dependencies).
// Run: node tests/browser_recipes.mjs (CHROME_BIN may override the browser path).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const requests = [];
const recipe = {
  id: "test123", name: "Test <img src=x onerror=alert(1)>", model: "Qwen/Qwen3.5-4B", compatible: true,
  description: "Two neurons", author: "tester", neurons: [],
  steer_neurons: [{ layer: 13, n: 7956, dose: -0.7, mode: "add" }, { layer: 14, n: 8949, dose: 0.7, mode: "add" }],
  sampling: { temperature: 0.7, repetition_penalty: 1.1 }, examples: [{ prompt: "Example prompt" }],
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/recipes") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ recipes: [recipe], count: 1 })); return;
  }
  if (url.pathname.startsWith("/api/recipes/")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(url.pathname.endsWith("other") ? { ...recipe, id: "other", compatible: false } : recipe)); return;
  }
  if (url.pathname === "/api/steer") {
    let data = ""; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); requests.push(body);
    res.setHeader("Content-Type", "text/event-stream");
    res.write(": keepalive\n\n");
    for (let row = 0; row < 3; row++) res.write(`data: ${JSON.stringify({ row, t: ["recipe answer", "base answer", "reverse answer"][row] })}\n\n`);
    const timer = setTimeout(() => res.end('data: {"row":null,"t":null}\n\n'), body.prompt === "slow" ? 5000 : 20);
    res.on("close", () => clearTimeout(timer)); return;
  }
  if (url.pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end('<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/recipes.css"><button id="recipes-open">Recipes</button><script type="module" src="/recipes.js"></script>'); return;
  }
  const files = { "/recipes.js": "explorer/static/recipes.js", "/i18n.js": "explorer/static/i18n.js",
    "/style.css": "explorer/static/style.css", "/recipes.css": "explorer/static/recipes.css" };
  if (files[url.pathname]) {
    res.setHeader("Content-Type", url.pathname.endsWith(".css") ? "text/css" : "text/javascript");
    res.end(await readFile(files[url.pathname])); return;
  }
  res.statusCode = 404; res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const tempRoot = process.env.OPENCODE_TMP || "/tmp/opencode";
await mkdir(tempRoot, { recursive: true });
const directory = await mkdtemp(join(tempRoot, "recipe-browser-"));
const browser = spawn(process.env.CHROME_BIN || "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu",
  "--no-first-run", "--no-default-browser-check", "--remote-debugging-pipe", `--user-data-dir=${directory}`],
{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let sequence = 0, buffer = "";
const pending = new Map();
const events = new Map();
browser.stdio[4].on("data", chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (!message.id) { events.get(`${message.sessionId}:${message.method}`)?.(message.params); continue; }
    const waiter = pending.get(message.id); if (!waiter) continue;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
  }
});
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}
try {
  const { targetId } = await command("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
  await command("Page.enable", {}, sessionId);
  const loaded = new Promise(resolve => events.set(`${sessionId}:Page.loadEventFired`, resolve));
  await command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` }, sessionId);
  await loaded;
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  // MutationObserver waits for DOM changes rather than relying on timing sleeps.
  async function wait(expression) {
    await evaluate(`new Promise((resolve, reject) => {
      const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('DOM condition timed out')); }, 10000);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); check();
    })`);
  }
  await wait("document.querySelector('#recipe-panel')");
  await evaluate("document.querySelector('#recipes-open').click()");
  await wait("document.querySelector('.rp-result')");
  await evaluate("document.querySelector('.rp-result').click()");
  await wait("!document.querySelector('#rp-send').disabled");
  assert.equal(await evaluate("document.querySelector('#rp-temperature').value"), "0.7");
  assert.equal(await evaluate("document.querySelector('#rp-detail img')"), null, "Remote HTML must not execute");
  async function send(text) {
    await evaluate(`document.querySelector('#rp-prompt').value = ${JSON.stringify(text)}; document.querySelector('#rp-form').requestSubmit()`);
    await wait("!document.querySelector('#rp-stop').hidden");
    if (text !== "slow") await wait("document.querySelector('#rp-stop').hidden");
  }
  await send("Hello");
  assert.equal(requests[0].neurons.length, 2);
  assert.equal(requests[0].temperature, 0.7);
  await send("Follow up");
  assert.deepEqual(requests[1].history[0].replies, ["recipe answer", "base answer", "reverse answer"]);
  await send("slow");
  await wait("document.querySelectorAll('.rp-output')[6].textContent.length > 0");
  await evaluate("document.querySelector('#rp-stop').click()");
  await wait("document.querySelector('#rp-stop').hidden");
  await send("After stop");
  assert.equal(requests[3].history.length, 2, "Stopped turns must be excluded");
  await evaluate("document.querySelector('#rp-temperature').value = '0'; document.querySelector('#rp-temperature').dispatchEvent(new Event('change', {bubbles:true}))");
  assert.equal(await evaluate("document.querySelectorAll('.rp-turn').length"), 0, "Changing sampling must clear history");
  await send("New settings");
  assert.deepEqual(requests[4].history, []);
  assert.equal(requests[4].temperature, 0);
  await evaluate("document.querySelector('#rp-id').value = 'https://neuronary.org/r/test123'; document.querySelector('#rp-load').requestSubmit()");
  await wait("document.querySelectorAll('.rp-turn').length === 0");
  await evaluate("document.querySelector('#rp-id').value = 'other'; document.querySelector('#rp-load').requestSubmit()");
  await wait("document.querySelector('#rp-status').textContent.includes('does not match')");
  assert.equal(await evaluate("document.querySelector('#rp-send').disabled"), true);
  await evaluate("import('/i18n.js?v=4').then(m => m.setLang('zh-CN'))");
  assert.equal(await evaluate("document.querySelector('#recipes-open').textContent"), "公开配方");
  console.log("Browser checks passed: search, link import, XSS safety, sampling, multi-neuron/multi-turn, stop, recipe switch, model mismatch, Chinese UI.");
} finally {
  browser.kill("SIGTERM");
  await new Promise(resolve => browser.once("exit", resolve));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
