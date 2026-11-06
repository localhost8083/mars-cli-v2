<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@mars_ai/marscli"><img alt="npm" src="https://img.shields.io/npm/v/@mars_ai/marscli?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

# Mars

Mars is a minimal, extensible agent harness that you can make your own.

Adapt Mars to your workflows, not the other way around. Customize Mars with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Mars packages](docs/packages.md) and share via npm or git.

Mars ships with powerful defaults but skips features like sub-agents and plan mode. Ask Mars to build what you want, or install a package that does it your way.

Use Mars [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Mars TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
npm install -g --ignore-scripts @mars_ai/marscli
```

Mars requires Node.js 22.19 or newer. Mars does not require dependency lifecycle scripts for a normal npm installation.

Start Mars in the directory where you want it to work:

```bash
cd /path/to/project
mars
```

For a built-in AI provider, run `/login` inside Mars to connect a subscription or API key. Then give Mars a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Share your OSS coding agent sessions

If you use Mars for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish Mars sessions
- Published Mars development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

Clone the repository, install its dependencies, and run Mars from source:

```bash
git clone https://github.com/localhost8083/mars-cli-v2
cd mars-cli-v2
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

## License

MIT
