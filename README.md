# neuron explorer

Steering-first neuron explorer for Qwen3.5-4B. Every MLP neuron in a layer is pushed up and down on a few prompts, every
rollout is kept, and the explorer lays the results out over a 3D view of the model.

![neuron explorer](explorer.png)

## Explorer

    uv sync
    uv run python explorer/server.py        # http://localhost:8791

Reads sweep runs from `runs/` and per-layer stats from `stats/`, both produced by the sweep below; the caches in
`explorer/cache/` ship with the repo. Loads Qwen3.5-4B locally (MPS, CUDA or CPU) for live
steered chat, lens, connections and live inference over your own text.

The R and J++ lens rows read the maps of [bubskee/qwen3.5-4b-r-jpp-lenses](https://huggingface.co/bubskee/qwen3.5-4b-r-jpp-lenses)
(Apache-2.0):

    hf download bubskee/qwen3.5-4b-r-jpp-lenses --local-dir explorer/cache/rjpp

- **map**: the model's layers in perspective, attention and MLP per layer, one point per neuron. Hover shows a neuron's
  steer lens and R lens; click opens it; click a layer's label to view its sheet face-on. `writes` places
  neurons with similar down-projection columns next to each other.
- **list**: units ranked by word-cluster mass against random-direction controls; `lens` searches the steer, R and logit
  lenses for a token, `fires` runs your text through the model and filters neurons by activation.
- **neuron**: steered rollouts per prompt and dose, a three-column multi-turn steered chat (−, 0, +), lens and
  connections, a name, and where it fires on web text: its strongest FineFineWeb contexts per sign, each token shaded
  by the neuron's activation, and the domains it concentrates in.
- **embeddings**: UMAP of a layer's rollouts, coloured by neuron, prompt, dose or kind.
- **language**: the interface follows the browser language on first visit; the menu at the right of the header
  switches between English and Simplified Chinese (the choice is kept in this browser). Translations live in
  `explorer/static/i18n.js`.
- **Claude** (fourth neuron-panel tab, or the right-edge handle): a chat running the `claude` CLI (installed and
  logged in) with the explorer as an MCP server (`explorer/agent_mcp.py`). It reads neurons, cones and lenses, runs the
  live model (steering, activations, next-token logprobs, ablations), moves the map, list and highlights, and has file
  tools and a shell in your home folder. Its prompt is `explorer/agent_prompt.md` plus `explorer/agent_methodology.md`, and
  `explorer/agent_prompt.local.md` when present (untracked, for your own additions);
  `EXPLORER_CLAUDE_MODEL` picks the model. The server defaults to local-only access; see below for remote deployment.

### Public recipes: chat directly with steered Qwen

Click **Public recipes / 公开配方** in the top bar; no neuron selection or Claude/Codex setup is needed.

1. Search the public neuronary catalog (top/new/hot, with pagination), or paste a
   `https://neuronary.org/r/<id>` link / recipe ID and click **Load**.
2. Inspect the recipe's model, description, neurons and signed doses. Public reads do not require
   a neuronary account or token. Recipes for another model cannot be run.
3. Enter a prompt, or select one of the recipe's example prompts. The model generates three streaming
   columns: **Recipe**, **Original**, and **Reversed** (all neuron doses reversed, not an undo operation).
   All listed neurons are applied together; these are runtime activation interventions, not saved weight edits.
4. Continue chatting: each column uses its own previous answers. **Stop** cancels generation;
   interrupted/failed turns are excluded from subsequent history. The latest 50 completed turns are retained
   in generation context. Switching recipes or changing sampling settings clears the conversation.

Generation settings start with the recipe's recommended temperature, repetition penalty, min-p and seed
(or runtime defaults); they can be adjusted together with the output token limit. The server must have the
live model enabled. The existing single-neuron Chat tab is unchanged. GPU memory must accommodate three
parallel sequences, so lower the token limit or clear long chats if memory is tight.

Tests:

```bash
uv run python -m unittest discover -s tests -v
node tests/browser_recipes.mjs  # requires local Google Chrome; override with CHROME_BIN if needed
```

### RunPod / remote access

The API can launch agents with shell access. **Do not expose it without a strong password.**
On your RunPod GPU Pod, expose **HTTP port 8791** in the Pod settings (not just a TCP port), then run:

```bash
uv sync
export EXPLORER_PASSWORD='replace-with-a-long-random-password'
export EXPLORER_HOST=0.0.0.0
export PORT=8791
# Replace <pod-id> with your Pod ID. In RunPod this is inferred from RUNPOD_POD_ID if omitted.
export EXPLORER_PUBLIC_URL='https://<pod-id>-8791.proxy.runpod.net'
export EXPLORER_TRUST_PROXY_HEADERS=1
uv run python explorer/server.py
```

Open that HTTPS URL (or RunPod's **Connect → HTTP Service [8791]** link). The browser will ask for
username **`explorer`** and the password from `EXPLORER_PASSWORD`. The model runs on the Pod's GPU;
the browser uses same-origin API requests and streaming responses through the RunPod proxy.
When `RUNPOD_POD_ID` is present, the default bind address is `0.0.0.0`; otherwise it remains `127.0.0.1`.

For a custom domain or another reverse proxy, set `EXPLORER_PUBLIC_URL` to the exact external origin
(scheme, hostname and non-default port, **no path**). Preserve the original `Host` and `Authorization`
headers, disable response buffering for streaming endpoints, and use HTTPS for the public connection.
If the proxy rewrites `Host`, enable `EXPLORER_TRUST_PROXY_HEADERS=1` and have it overwrite
`X-Forwarded-Host` with the original public authority. This option defaults to enabled when
`RUNPOD_POD_ID` is present. It only accepts the exact configured public domain and still requires
password authentication; it does not trust arbitrary forwarded domains or disable Origin checks.
Changing only the bind address is not sufficient: the server validates Host and Origin to prevent
DNS rebinding and cross-site requests. Remote configuration without a password fails at startup.
Do not use `0.0.0.0` as the browser URL or enable wildcard CORS/Host access.

For a 403 response, check the server's `Explorer rejected request` warning: it includes the rejection
reason and observed Host/Origin/proxy headers (not credentials). Ensure `EXPLORER_PUBLIC_URL` matches
the actual browser URL, not a literal placeholder or an empty Pod ID. Restart after changing environment variables.

The Claude/Codex MCP tools continue to use the internal loopback URL and automatically authenticate.
Custom scripts accessing the API must authenticate too, for example:

```bash
curl -u "explorer:$EXPLORER_PASSWORD" http://127.0.0.1:8791/api/status
```

Initial startup downloads model files from Hugging Face; ensure sufficient GPU memory, disk space
and network access. To use only cached data without loading model weights, set `EXPLORER_NO_MODEL=1`.

## Sweep

Runs on a CUDA 13 GPU pod with the steering fork of vLLM ([RhizoNymph/vllm](https://github.com/RhizoNymph/vllm)).

    bash sweep/setup_pod.sh                                   # fork, deps, model; writes /workspace/env.sh
    python sweep/neuron_stats.py --layers 22 --tokens 2000000 --out stats/q35-4b
    python sweep/steer_sweep.py --stats stats/q35-4b_L22.npz --design main_rel --dose-unit rel \
        --neurons all --random-controls 256 --run q35-4b-L22
    sweep/run_depth.sh "4 9 13 17" 384 64                     # random-subset sweep across several layers

`main_rel` doses are fractions of the median residual norm leaving the layer: {who, snake, orange} × {−0.7, +0.5, +0.8}
and {free} × {+3}, plus one unsteered baseline per prompt.

| script | output |
|---|---|
| `sweep/neuron_stats.py` | per-neuron activation extremes by sign regime, down columns, residual norms |
| `sweep/steer_sweep.py` | `runs/<run>.jsonl`: text, token ids, logprobs, top-k per step; optional activation captures |
| `sweep/rank.py` | `runs/<run>.units.jsonl`: distinctive words, cluster mass, percentile against controls |
| `sweep/steer_lens.py` | `stats/steer_lens_L{l}.npz`: next-token Δlogprob and KL for ±0.8 pushes on every neuron |
| `sweep/depth_report.py` | `runs/depth_report.json`: per-layer share of neurons above controls, coherence, top units |
| `sweep/shift.py` | word-shift score against controls, all words counted |
| `sweep/merge_runs.py` | joins sharded runs of one layer |
| `sweep/check_equivalence.py` | HF vs vLLM steering and capture agreement |
| `sweep/bench.py`, `sweep/peek.py` | throughput conditions; terminal views of a run |
| `explorer/build_embeddings.py` | `runs/<run>.umap.json` |
| `explorer/build_layout.py` | `explorer/cache/layout_writes.npz` |
| `explorer/build_connections.py` | `explorer/cache/connections.npz`: each neuron's 24 strongest direct-path links up and down |
| `sweep/fit_input_lens.py` | `S.pt`: the fitted input map S_L (token embeddings to the residual each MLP reads, layers 0–31), RelP rules of safety-research/jpp_lens; shards over prompts, merged by `num_prompts`; copy to `explorer/cache/slens/S.pt` |
| `explorer/build_s_index.py` | `explorer/cache/s_index.npz`: each neuron's top S-lens (read side) tokens, both poles |
| `explorer/build_rjpp_index.py` | `explorer/cache/r_index.npz`, `jpp_index.npz`: each neuron's top R- and J++-lens tokens, both poles (needs the R/J++ release in `explorer/cache/rjpp/`) |
| `sweep/finefineweb.py` | `<out>/corpus.npz`, `urls.json`, `acts.npz`: a domain-balanced FineFineWeb sample (about 20M tokens over 66 domains) and every neuron's top contexts per sign and per-domain activation statistics; copy the three files to `explorer/cache/ffw/` |
| `sweep/capture_prefill.py` | `captures/<run>.mlp_in.npy`: MLP input at the last prompt token at the run's capture layers, steered |

`research_log.md` holds the findings and reasoning; `NOTES.md` the source notes.

## License

MIT, see [LICENSE](LICENSE).
