<p align="center">
  <img src="media/icon.png" alt="Opencodex" width="120">
</p>

<h1 align="center">Opencodex</h1>

A standalone, Codex-style coding agent that runs entirely inside VS Code. Opencodex is backed directly by OpenCode's anonymous **free** models. No OpenCode account, API key, OmniRoute, or local model server is required.

Open a project, pick a free model, and describe what you want. Opencodex reads files, searches your codebase, applies edits, and runs commands in a visible agent loop and then streams a Markdown answer with its reasoning and work steps shown alongside.

## Highlights

- **Free and anonymous**: Uses OpenCode's live free-only model catalog. Only models currently marked free are offered.
- **No account or API key**: Works out of the box; the first-launch screen is a simple one-time setup.
- **Codex-style agent loop**: A collapsible work panel shows each tool step, live activity, and streamed reasoning.
- **Safe by default**: All agent paths are confined to the open workspace, `.env` and credential files are blocked, and file edits participate in editor undo.
- **Flexible approval modes**: Confirm every action, auto-approve edits, or run fully autonomous with auto-approved edits and commands.
- **Conversation management**: Switch, archive, and permanently delete conversations; Git restore points roll back tracked files to any agent response.
- **Resilient streaming**: Up to five visible connection retries, animated streamed answers, and persistent red error messages instead of fake `Done.` responses.

## Get started

1. Install the extension from the VS Code Marketplace.
2. Open a project folder and click the **Opencodex** icon in the Activity Bar.
3. Complete the first-launch settings screen. SearXNG is optional; leave it blank to skip web search.
4. Select a free model from the live model picker below the composer.
5. Start a conversation.

> **Note on models:** There is no automatic model selection. Opencodex remembers the model you explicitly choose. If a model leaves OpenCode's free catalog, the picker resets and asks you to choose another.

## Features

### Agent loop & interface

- Switchable, archivable project conversations with permanent deletion for archived conversations
- Right-aligned user bubbles and Markdown-formatted assistant responses, with headings, lists, emphasis, links, inline code, and fenced code blocks
- Collapsible Codex-style work panel with an animated loading sheen while the agent reasons or uses tools
- Animated streamed answers with persistent work details for the current run
- Separate work lines for each agent-loop step, plus Markdown-formatted reasoning and work details
- Automatic follow-to-bottom scrolling inside active thought and work panels, during streamed responses, and during tool activity
- Scroll-aware jump-to-latest control with a live activity state
- Message timestamps, copy actions, and Git-tree restore points for Git-tracked projects
- One-item prompt scheduling with remove and `Steer` controls
- Invisible continuation nudges when a model clearly stops before performing its next stated action

### Reliability

- Provider generation failures render as persistent red error messages instead of false `Done.` responses
- Five provider connection attempts with visible reconnect activity
- Live free-only OpenCode model catalog, refreshed automatically

### Settings

First-launch setup covers agent steps, approval mode, and optional SearXNG:

| Setting | Default | Description |
| --- | --- | --- |
| `opencodex.model` | *(none)* | Selected free OpenCode model ID. Choose it from the sidebar. |
| `opencodex.maxSteps` | `20` | Maximum tool-loop steps per request (1-50). |
| `opencodex.approvalMode` | `ask` | `ask`: confirm every edit and command; `edits`: auto-approve edits; `autonomous`: auto-approve edits and commands. |
| `opencodex.searxngUrl` | *(empty)* | Optional base URL for a SearXNG instance with JSON output enabled. |

## Safety model

- All paths are constrained to the open workspace; files outside it cannot be read, written, or deleted.
- `.env` and common credential files cannot be read or edited.
- Approval modes can require every confirmation, auto-approve edits, or auto-approve edits and commands.
- Edits use VS Code workspace edits and participate in editor undo.
- Commands always require approval.
- Only anonymous models whose OpenCode IDs are currently marked free are shown.

## Web search (optional)

Set a SearXNG base URL in Settings to enable the agent's `web_search` tool. The server must allow JSON output (`format=json`).

- `http://127.0.0.1:8080` works when the extension host runs directly on your machine.
- Dev Containers and remote workspaces need an address that can reach the host machine, for example its LAN address, or `host.docker.internal` where supported.

## Requirements

- VS Code **1.96.0** or newer
- An internet connection to `https://opencode.ai/zen/v1` for the model catalog and completions
- (Optional) A SearXNG instance with JSON output enabled for web search

## Known limitations

- Model availability depends on OpenCode's free catalog; the picker is refreshed live and resets if your chosen model is removed.
- Web search requires a user-provided SearXNG instance; no bundled search backend is included.
- Restore points are created only for Git-tracked projects and only for newer responses.

## Commands

| Command | Description |
| --- | --- |
| `Opencodex: Focus Chat` | Focus the Opencodex chat view. |
| `Opencodex: Open Settings` | Open the settings screen. |
| `Opencodex: New Chat` | Start a new conversation. |

## Repository and support

- Bug reports and feedback: open a GitHub **Issue** and mention the extension version, your VS Code version, and the selected free model when possible.
- Version history: check the repository **Releases** tab for per-version changes.
- Contributions: open a pull request. The Development section below shows how to build and verify changes locally.
- Model availability changes: OpenCode's free catalog changes over time; refresh the model picker for the current list.

## License

MIT. See [LICENSE](LICENSE).
