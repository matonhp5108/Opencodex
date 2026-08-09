<p align="center">
  <img src="media/icon.png" alt="Opencodex" width="120">
</p>

<h1 align="center">Opencodex</h1>
<h3 align="center">The hub for free AI coding</h3>

A standalone, Codex-style coding agent that runs entirely inside VS Code. Opencodex allows you to use **free** models from multiple providers to power your agent.

Open a project, pick a provider and a free model, and describe what you want. Opencodex works exactly like an agent like OpenAI Codex. The only difference is, Opencodex skips the "pay for more usage" bs and complex setups. Opencodex lets you use excellent free models from multiple providers right away, with no account or API key required to start.

## Highlights

- **Free**: Uses each provider's live free-only model catalog. Only models currently marked free are offered.
- **Plans first**: The agent can present an ordered plan of the main design aspects before doing work; it stays pinned at the top of the response while the work runs below.
- **No account or API key required to start**: Opencodex has models that work anonymously out of the box; the first-launch screen is a simple one-time setup. Optional providers need a free API key configured in Settings.
- **Local model support**: Run models on your own machine with Ollama. No cloud, no key.
- **Codex-style agent loop**: A collapsible work panel shows each tool step, live activity, and streamed reasoning.
- **Safe**: All agent paths are confined to the open workspace, `.env` and credential files are blocked, and file edits participate in editor undo.
- **Flexible approval modes**: Confirm every action, auto-approve edits (still confirms destructive commands), or use **Open access** to auto-approve edits and commands.
- **Conversation management**: Switch, archive, and permanently delete conversations; Git restore points roll back tracked files to any agent response.
- **Resilient streaming**: Up to five visible connection retries, animated streamed answers, and persistent red error messages instead of fake `Done.` responses.

## Get started

1. Install the `Opencodex` extension from the VS Code Marketplace.

2. Open a project folder and click the **O** icon in your tab bar (the buttons on the top right of your editor).

3. Complete the first-launch settings screen. **OpenCode** is the default provider and needs no API key to start. To use another, configure its API key in Settings. SearXNG is optional; leave it blank to skip web search, or read the [SearXNG installation instructions](https://docs.searxng.org/admin/installation.html) for details on how to install it.

4. Select a free model from the live model picker below the composer.

5. Start a conversation.

> **Note on models:** Opencodex does not have any control over which models are shown by the providers. Some models may be removed or incompatible with Opencodex. 

## Model providers

Providers are selected in Settings (`opencodex.provider`). Every provider speaks the same OpenAI-compatible API, so switching is a one-click change. API keys are stored **per provider** in VS Code's secure secret storage. A key saved for one provider is never sent to another, and keys can also be supplied through an environment variable.

| Provider | API key | Free models shown | Key location / env var |
| --- | --- | --- | --- |
| **OpenCode** *(default)* | Optional | All IDs ending in `-free` (live catalog) | Anonymous. Key only for models that require one |
| **OpenRouter** | Yes | All IDs ending in `:free` (live catalog) | `https://openrouter.ai/keys` · `OPENROUTER_API_KEY` |
| **Groq** | Yes | Every model (live catalog; free tier covers all) | `https://console.groq.com/keys` · `GROQ_API_KEY` |
| **Google Gemini** | Yes | Free-tier models (live catalog; 2.5/2.0 Flash, Pro, Gemma) | `https://aistudio.google.com/apikey` · `GEMINI_API_KEY` |
| **Mistral** | Yes | Known free tier (Small, Nemo) | `https://console.mistral.ai/api-keys` · `MISTRAL_API_KEY` |
| **Ollama** *(local)* | No | Everything installed locally | Run `ollama serve` · `http://localhost:11434/v1` |

- Cloud API keys are free to create but have rate limits; OpenCode works without a key (it is optional for models that require one), and the local providers have no key at all.
- Keys are saved **per provider**: a key stored for Gemini is only ever sent to Gemini, so other providers are unaffected. A saved key wins over the environment variable. Keys are never written to `settings.json` or shown again after saving. The settings screen only reports that a key exists and offers a **Remove saved key** button.
- The model picker only lists **text/chat** models the selected provider currently marks free. Image, vision, audio, speech, embedding, and rerank models are filtered out. Provider free catalogs change over time; reopening Settings refreshes the model list automatically as changes save.
- Providers whose APIs expose pricing or free markers (OpenCode, OpenRouter) and providers whose entire catalog is free-tier (Groq) are detected live. Gemini's free tier is derived from its live catalog. For the remaining curated provider (Mistral), add new free models to the **Extra free model IDs** setting instead of waiting for a release.

## Features

### Agent loop & interface

- Switchable, archivable project conversations with permanent deletion for archived conversations
- Right-aligned user bubbles and Markdown-formatted assistant responses, with headings, lists, emphasis, links, inline code, and fenced code blocks
- Collapsible Codex-style work panel with an animated loading sheen while the agent reasons or uses tools
- Animated streamed answers with persistent work details for the current run
- Pinned plan card at the top of each response when the agent plans first, listing the ordered main design aspects
- Separate work lines for each agent-loop step, plus Markdown-formatted reasoning and work details
- Automatic follow-to-bottom scrolling inside active thought and work panels, during streamed responses, and during tool activity
- Scroll-aware jump-to-latest control with a live activity state
- Message timestamps, copy actions, and Git-tree restore points for Git-tracked projects
- One-item prompt scheduling with remove and `Steer` controls
- Invisible continuation nudges when a model clearly stops before performing its next stated action


## Safety model

- All paths are constrained to the open workspace; files outside it cannot be read, written, or deleted.
- `.env` and common credential files cannot be read or edited.
- Approval modes can require every confirmation, auto-approve edits, or auto-approve edits and commands (**Open access**).
- Edits use VS Code workspace edits and participate in editor undo.
- In auto-edit mode, safe commands run without confirmation, but destructive commands (deletes, force pushes, discarding Git changes, wiping data) still ask.
- In ask mode, commands and edits require confirmation.
- In Open access mode, all commands and edits run without confirmation.
- API keys for cloud providers are stored in VS Code's secure SecretStorage, never in workspace files.

## Web search (optional)

Set a SearXNG base URL in Settings to enable the agent's `web_search` tool. The server must allow JSON output (`format=json`).

- `http://localhost:8888` (the default) works when the extension host runs directly on your machine.
- Dev Containers and remote workspaces need an address that can reach the host machine, for example its LAN address, or `host.docker.internal` where supported.

Read the [SearXNG installation instructions](https://docs.searxng.org/admin/installation.html) for details on how to install it.

## Requirements

- VS Code **1.106.0** or newer
- An internet connection to the chosen provider's API for the model catalog and completions
- (Optional) A free API key for cloud providers such as OpenRouter, Groq, Gemini, or Mistral
- (Optional) A SearXNG instance with JSON output enabled for web search
- (Optional) Ollama running locally for the local provider

## Known limitations

- Model availability depends on the active provider's free catalog; the picker is refreshed live and resets if your chosen model is removed.
- Free-tier rate limits of the selected provider apply (OpenCode and local providers have no key or quota).
- Mistral has a small curated free list (its API exposes no free marker); new free models there can be added through the **Extra free model IDs** setting. All other providers resolve free models from their live catalog.
- Web search requires a user-provided SearXNG instance; no bundled search backend is included.
- Restore points are created only for Git-tracked projects and only for newer responses.

## Commands

| Command | Description |
| --- | --- |
| `Opencodex: Open Chat` | Open the Opencodex chat view (the **O** icon in your tab bar). |
| `Opencodex: Focus Chat` | Focus the Opencodex chat view. |
| `Opencodex: Open Settings` | Open the settings screen. |
| `Opencodex: New Chat` | Start a new conversation. |

## Repository and support

- Bug reports and feedback: open a GitHub **Issue** and mention the extension version, your VS Code version, and the selected free model when possible.
- Version history: check the repository **Releases** tab for per-version changes.
- Contributions: open a pull request. The Development section below shows how to build and verify changes locally.
- Model availability changes: each provider's free catalog changes over time; refresh the model picker for the current list.

## License

MIT. See [LICENSE](LICENSE).
