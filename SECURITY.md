# Security Policy

## Reporting a vulnerability

If you discover a security issue in `fexor-code` — a vulnerability in the CLI, a
leaked secret in git history, or a supply-chain concern — please report it
**privately** rather than opening a public issue:

- Open a [GitHub Security Advisory](https://github.com/jennofrie/fexor-code/security/advisories/new) (preferred), or
- Contact the maintainer (**Profexor**) through the repository's contact channels.

Please include reproduction steps and the affected version/commit. You'll get an
acknowledgement as soon as practical; coordinated disclosure is appreciated.

## Scope

`fexor-code` is a source-available fork of Claude Code for local/terminal use.
In scope: the CLI build, the reconstructed feature-flag code, the provider
launchers, and anything that could leak credentials or execute unintended code.

Out of scope: the behavior of the underlying language models, the upstream
Anthropic services, and third-party model providers (DeepSeek, Alibaba, OpenAI,
AWS, Google) — report those to their respective vendors.

## Secret hygiene

This project is built to **phone home to nobody**, and the same discipline
applies to the repository:

- `.env`, `.env.*`, and key files are git-ignored. **Never commit credentials.**
- Provider launchers read API keys from `.env.<provider>` files or the macOS
  Keychain — both kept out of version control.
- If a secret is ever committed, treat it as compromised: rotate it immediately,
  then scrub history. Do not rely on a later deletion commit alone.

## Safe-use note

`fexor-code` removes the CLI's prompt-level guardrails. The model's own safety
training still applies, but you are responsible for how you operate the agent —
especially with broad permissions, auto-approval modes, or untrusted MCP
servers. Review permission settings before running unattended.

---

Maintained by **Profexor**.
