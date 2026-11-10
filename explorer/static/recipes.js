import { getLang } from "./i18n.js?v=4";

const words = {
  en: {
    open: "Public recipes", title: "Public recipes · Qwen chat", close: "Close", search: "Search", query: "Name, tag or neuron…",
    load: "Load", link: "neuronary URL or recipe ID", top: "Top", new: "New", hot: "Hot", prev: "Previous", next: "Next",
    empty: "Search or paste a recipe link to begin. No Claude/Codex required.", loading: "Loading…", noResults: "No recipes found.",
    notice: "Runtime activation steering, not saved weight edits. Each column keeps its own conversation history.",
    temperature: "Temperature", penalty: "Repetition penalty", seed: "Seed", tokens: "Max new tokens", minp: "Min-p",
    send: "Send", stop: "Stop", clear: "Clear chat", prompt: "Talk to the steered Qwen model…", up: "Recipe", zero: "Original", down: "Reversed",
    mismatch: "Recipe model does not match the loaded model. Generation is disabled.", ready: "Recipe loaded. Chat history cleared.",
    changed: "Settings changed. Chat history cleared.", stopped: "Stopped (partial response excluded from future history).",
    interrupted: "Stream ended unexpectedly. Partial response excluded from future history.", model: "Model", parameters: "Neurons and doses",
    settings: "Generation settings (defaults come from the recipe)", examples: "Example prompts (click to try)", invalid: "Enter a recipe ID or an https://neuronary.org/r/… link.",
    failed: "Failed", page: "Results", pending: "Generating…", missing: "Load a compatible recipe first.",
  },
  zh: {
    open: "公开配方", title: "公开配方 · Qwen 对话", close: "关闭", search: "搜索", query: "名称、标签或神经元…",
    load: "加载", link: "neuronary 配方链接或 ID", top: "热门", new: "最新", hot: "趋势", prev: "上一页", next: "下一页",
    empty: "搜索或粘贴配方链接开始，无需 Claude/Codex。", loading: "正在加载…", noResults: "没有找到配方。",
    notice: "这是运行时激活干预，不会保存权重修改。三列分别保留自己的多轮对话历史。",
    temperature: "温度", penalty: "重复惩罚", seed: "随机种子", tokens: "最大生成 token", minp: "Min-p",
    send: "发送", stop: "停止", clear: "清空对话", prompt: "与干预后的 Qwen 模型聊天…", up: "按配方干预", zero: "原始模型", down: "反向干预",
    mismatch: "配方模型与当前加载的模型不一致，无法生成。", ready: "配方已加载，已清空对话历史。",
    changed: "参数已改变，已清空对话历史。", stopped: "已停止（部分输出不会加入后续对话历史）。",
    interrupted: "输出流意外中断，部分输出不会加入后续对话历史。", model: "模型", parameters: "神经元与干预强度",
    settings: "生成参数（默认使用配方推荐值）", examples: "示例提示词（点击试用）", invalid: "请输入配方 ID 或 https://neuronary.org/r/… 链接。",
    failed: "失败", page: "结果", pending: "正在生成…", missing: "请先加载兼容的配方。",
  },
};
const tr = key => words[getLang() === "zh-CN" ? "zh" : "en"][key];
const dialog = document.createElement("dialog");
dialog.id = "recipe-panel";
dialog.innerHTML = `
  <div class="rp-heading"><strong data-rp="title"></strong><button id="rp-close" data-rp="close"></button></div>
  <p class="dim" data-rp="notice"></p>
  <div class="rp-layout">
    <section class="rp-browser">
      <form id="rp-search"><input id="rp-query" data-rp-placeholder="query"><select id="rp-sort"><option value="top" data-rp="top"></option><option value="new" data-rp="new"></option><option value="hot" data-rp="hot"></option></select><button data-rp="search"></button></form>
      <form id="rp-load"><input id="rp-id" data-rp-placeholder="link"><button data-rp="load"></button></form>
      <p id="rp-search-status" role="status" class="dim"></p>
      <div id="rp-results"></div>
      <div class="rp-pages"><button id="rp-prev" data-rp="prev"></button><button id="rp-next" data-rp="next"></button></div>
    </section>
    <section class="rp-chat">
      <div id="rp-detail"></div>
      <details id="rp-settings"><summary data-rp="settings"></summary><div class="rp-settings-grid">
        <label><span data-rp="temperature"></span><input id="rp-temperature" type="number" min="0" max="10" step="any" value="0"></label>
        <label><span data-rp="penalty"></span><input id="rp-penalty" type="number" min="0.000001" max="10" step="any" value="1"></label>
        <label><span data-rp="minp"></span><input id="rp-minp" type="number" min="0" max="1" step="any" value="0"></label>
        <label><span data-rp="seed"></span><input id="rp-seed" type="number" min="0" max="9007199254740991" step="1" value="0"></label>
        <label><span data-rp="tokens"></span><input id="rp-tokens" type="number" min="1" max="4096" step="1" value="300"></label>
      </div></details>
      <p id="rp-status" role="status" class="dim"></p>
      <div id="rp-thread" aria-live="polite"></div>
      <form id="rp-form"><textarea id="rp-prompt" rows="2" required data-rp-placeholder="prompt"></textarea><div><button id="rp-send" data-rp="send"></button><button id="rp-stop" type="button" data-rp="stop" hidden></button><button id="rp-clear" type="button" data-rp="clear"></button></div></form>
    </section>
  </div>`;
document.body.append(dialog);
const $ = id => dialog.querySelector(`#${id}`);
let selected = null, turns = [], running = null, searchController = null, loadController = null;
let offset = 0, count = 0, shown = 0, opened = false;
const limit = 20;
function node(tag, text, cls) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
}
function translate() {
  document.querySelector("#recipes-open").textContent = tr("open");
  dialog.querySelectorAll("[data-rp]").forEach(el => { el.textContent = tr(el.dataset.rp); });
  dialog.querySelectorAll("[data-rp-placeholder]").forEach(el => {
    el.placeholder = tr(el.dataset.rpPlaceholder); el.setAttribute("aria-label", el.placeholder);
  });
  $("rp-sort").setAttribute("aria-label", tr("search"));
  renderDetail();
  renderTurns();
  controls();
}
function controls() {
  dialog.querySelectorAll("input, select, textarea, button").forEach(el => {
    if (el.id !== "rp-close" && el.id !== "rp-stop") el.disabled = !!running;
  });
  $("rp-send").disabled = !!running || !selected?.compatible;
  $("rp-prompt").disabled = !!running || !selected?.compatible;
  $("rp-prev").disabled = !!running || offset === 0;
  $("rp-next").disabled = !!running || offset + shown >= count;
  $("rp-stop").hidden = !running;
}
async function readJSON(url, signal) {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.error || String(response.status));
  return data;
}
async function search(reset = false) {
  if (running) return;
  if (reset) offset = 0;
  searchController?.abort();
  const controller = searchController = new AbortController();
  $("rp-search-status").textContent = tr("loading");
  try {
    const params = new URLSearchParams({ q: $("rp-query").value, sort: $("rp-sort").value, offset, limit });
    const data = await readJSON(`/api/recipes?${params}`, controller.signal);
    if (controller !== searchController) return;
    count = data.count ?? data.recipes.length; shown = data.recipes.length;
    $("rp-results").replaceChildren();
    for (const recipe of data.recipes) {
      const button = node("button", undefined, "rp-result"); button.type = "button";
      button.append(node("strong", recipe.name), node("span", `${recipe.author || ""} · ${recipe.model || ""}`, "dim"),
        node("span", recipe.description || ""));
      button.onclick = () => load(recipe.id);
      $("rp-results").append(button);
    }
    $("rp-search-status").textContent = shown ? `${offset + 1}–${offset + shown} / ${count}` : tr("noResults");
  } catch (error) {
    if (error.name !== "AbortError") $("rp-search-status").textContent = `${tr("failed")}: ${error.message}`;
  } finally { if (controller === searchController) controls(); }
}
export function recipeID(value) {
  value = value.trim();
  if (/^[A-Za-z0-9_-]{1,100}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["neuronary.org", "www.neuronary.org"].includes(url.hostname)) {
      const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,100})\/?$/);
      if (match) return match[1];
    }
  } catch {}
  throw new Error(tr("invalid"));
}
async function load(value) {
  if (running) return;
  loadController?.abort();
  const controller = loadController = new AbortController();
  $("rp-status").textContent = tr("loading");
  try {
    const id = recipeID(value);
    const recipe = await readJSON(`/api/recipes/${encodeURIComponent(id)}`, controller.signal);
    if (controller !== loadController) return;
    selected = recipe; turns = [];
    $("rp-id").value = id;
    const sampling = recipe.sampling || {};
    for (const [id, key, fallback] of [["temperature", "temperature", 0], ["penalty", "repetition_penalty", 1],
      ["minp", "min_p", 0], ["seed", "seed", 0], ["tokens", "max_new", 300]]) {
      $(`rp-${id}`).value = sampling[key] ?? fallback;
    }
    renderDetail(); renderTurns(); controls();
    $("rp-status").textContent = tr(recipe.compatible ? "ready" : "mismatch");
  } catch (error) {
    if (error.name !== "AbortError") $("rp-status").textContent = `${tr("failed")}: ${error.message}`;
  }
}
function renderDetail() {
  const detail = $("rp-detail"); detail.replaceChildren();
  if (!selected) { detail.append(node("p", tr("empty"))); return; }
  const title = node("a", selected.name);
  title.href = `https://neuronary.org/r/${encodeURIComponent(selected.id)}`;
  title.target = "_blank"; title.rel = "noopener noreferrer";
  const heading = node("h2"); heading.append(title);
  detail.append(heading, node("p", selected.description || ""),
    node("p", `${tr("model")}: ${selected.model} · ${selected.author || ""}`, "dim"));
  if (!selected.compatible) detail.append(node("p", `${tr("mismatch")} (${selected.loaded_model})`, "rp-error"));
  const details = node("details"), summary = node("summary", `${tr("parameters")} (${selected.steer_neurons.length})`);
  details.append(summary, node("pre", selected.steer_neurons.map(n => `L${n.layer} N${n.n}  ${n.mode} ${n.dose}`).join("\n")));
  detail.append(details);
  if (selected.examples?.length) {
    const examples = node("details"); examples.append(node("summary", tr("examples")));
    for (const example of selected.examples) {
      if (!example.prompt) continue;
      const button = node("button", example.prompt, "rp-example"); button.type = "button";
      button.onclick = () => { $("rp-prompt").value = example.prompt; $("rp-prompt").focus(); };
      examples.append(button);
    }
    detail.append(examples);
  }
}
function renderTurns() {
  const thread = $("rp-thread"); thread.replaceChildren();
  for (const turn of turns) {
    const wrapper = node("article", undefined, "rp-turn");
    wrapper.append(node("h3", turn.user));
    const columns = node("div", undefined, "rp-columns");
    turn.outputs = [];
    for (let i = 0; i < 3; i++) {
      const col = node("section"), output = node("div", turn.replies[i], "rp-output");
      col.append(node("strong", tr(["up", "zero", "down"][i])), output); columns.append(col); turn.outputs.push(output);
    }
    wrapper.append(columns);
    if (turn.error) wrapper.append(node("p", turn.error, "rp-error"));
    thread.append(wrapper);
  }
  thread.scrollTop = thread.scrollHeight;
}
function reset() { turns = []; renderTurns(); }
function settings() {
  const values = {};
  for (const [id, key] of [["temperature", "temperature"], ["penalty", "repetition_penalty"],
    ["minp", "min_p"], ["seed", "seed"], ["tokens", "max_new"]]) {
    const input = $(`rp-${id}`);
    if (!input.reportValidity() || input.value === "") throw new Error(tr("settings"));
    values[key] = Number(input.value);
  }
  return values;
}
$("rp-form").onsubmit = async event => {
  event.preventDefault();
  if (running || !selected?.compatible) return;
  const prompt = $("rp-prompt").value.trim(); if (!prompt) return;
  let sampling;
  try { sampling = settings(); } catch (error) { $("rp-status").textContent = error.message; return; }
  // Do not change configuration beneath an active generation.
  searchController?.abort(); loadController?.abort();
  const history = turns.filter(t => t.complete).slice(-50).map(t => ({ user: t.user, replies: t.replies }));
  const turn = { user: prompt, replies: ["", "", ""], complete: false };
  turns.push(turn); renderTurns(); $("rp-prompt").value = "";
  const controller = running = new AbortController(); controls();
  $("rp-status").textContent = tr("pending");
  let complete = false;
  try {
    const response = await fetch("/api/steer", { method: "POST", headers: { "Content-Type": "application/json" },
      signal: controller.signal, body: JSON.stringify({ prompt, neurons: selected.steer_neurons, model: selected.model, history, ...sampling }) });
    if (!response.ok) {
      const error = await response.json(); throw new Error(error.detail || String(response.status));
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!block.startsWith("data: ")) continue;
        const ev = JSON.parse(block.slice(6));
        if (ev.error) throw new Error(ev.error);
        if (ev.row === null) { complete = true; continue; }
        if (![0, 1, 2].includes(ev.row)) continue;
        turn.replies[ev.row] += ev.t;
        turn.outputs[ev.row].textContent = turn.replies[ev.row];
        const thread = $("rp-thread");
        if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120) thread.scrollTop = thread.scrollHeight;
      }
    }
    if (!complete) throw new Error(tr("interrupted"));
    turn.complete = true; $("rp-status").textContent = "";
  } catch (error) {
    turn.error = error.name === "AbortError" ? tr("stopped") : error.message;
    $("rp-status").textContent = turn.error;
  } finally {
    running = null; renderTurns(); controls();
  }
};
$("rp-search").onsubmit = event => { event.preventDefault(); search(true); };
$("rp-sort").onchange = () => search(true);
$("rp-load").onsubmit = event => { event.preventDefault(); load($("rp-id").value); };
$("rp-prev").onclick = () => { offset = Math.max(0, offset - limit); search(); };
$("rp-next").onclick = () => { offset += limit; search(); };
$("rp-clear").onclick = () => { reset(); $("rp-status").textContent = ""; };
$("rp-stop").onclick = () => running?.abort();
$("rp-settings").onchange = () => { if (!running) { reset(); $("rp-status").textContent = tr("changed"); } };
function close() { running?.abort(); searchController?.abort(); loadController?.abort(); dialog.close(); }
$("rp-close").onclick = close;
dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
document.querySelector("#recipes-open").onclick = () => {
  dialog.showModal(); if (!opened) { opened = true; search(true); } $("rp-query").focus();
};
document.addEventListener("i18nchange", translate);
translate(); controls();
