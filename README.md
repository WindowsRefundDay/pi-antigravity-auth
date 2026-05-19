# pi-antigravity-auth

Pi Coding Agent provider extension for Google Antigravity OAuth models, plus Gemini CLI quota routing and multi-account rotation.

> **Warning**
>
> This project uses Google OAuth credentials and local account tokens. It may affect provider quotas, account standing, or ToS compliance. Use at your own risk.
>
> **Deprecation Notice**
>
> Following Google's official announcement transitioning from Gemini CLI to Antigravity CLI, the classic Gemini CLI and its separate quota are expected to be discontinued or restricted to enterprise customers via paid platform APIs. Consequently, the separate Gemini CLI quota models may become completely unsupported or cease to function in future releases. We highly recommend migrating your active workflows to the main Antigravity quota models.

## What you get

- **Google OAuth sign-in** with automatic token refresh
- **Dual quota system** (Antigravity quota and Gemini CLI fallback quota)
- **Auto Quota**: Intelligent automatic load balancing and fallback between Antigravity and Gemini CLI quota pools
- **Multi-account rotation**
- **Real-time SSE streaming** with tool calls and thinking blocks
- **Variant-style thinking control**
- **Automatic import** from `opencode-antigravity-auth`
- **Native Pi provider integration**

---

## Getting Started

### 1. Installation

#### For humans
Run the installation command in your terminal:
```bash
pi install git:github.com/WindowsRefundDay/pi-antigravity-auth
```
Then restart your Pi environment:
```text
/reload
```

#### For an AI agent
Paste this request to automate installation:
```text
I want to install the pi-antigravity-auth extension for Pi. Please read the README at https://github.com/WindowsRefundDay/pi-antigravity-auth (or fetch https://raw.githubusercontent.com/WindowsRefundDay/pi-antigravity-auth/main/README.md), locate the hidden "🤖 AGENT INSTRUCTIONS" block, and follow the exact step-by-step installation flow described there.
```

<!--
🤖 AGENT INSTRUCTIONS:
You are an AI assistant helping the user install the `pi-antigravity-auth` extension for their Pi environment. 
Follow these steps strictly:

1. **INSTALLATION**: First, run the following terminal command to install the package from GitHub:
   `pi install git:github.com/WindowsRefundDay/pi-antigravity-auth` 

2. **USER HANDOFF**: Because you cannot execute interactive slash commands or complete browser OAuth flows yourself, you MUST stop here. In your final response, explicitly instruct the user to run the following two commands in their chat/terminal:
   - Type `/reload` to restart the Pi environment.
   - Type `/login antigravity` to open the Google OAuth browser window and authenticate.

Do not attempt to run the slash commands yourself. Only provide them as text for the user to execute.
-->

### 2. Authentication

Authenticate your Google account by typing this slash command in Pi:
```text
/login antigravity
```
*Note: If Google revokes a token, that account is automatically removed from your local storage.*

---

## Models & Variants

List registered models:
```bash
pi --list-models antigravity
```

### Available Models

| Model | Notes |
|---|---|
| `gemini-3.5-pro-high` | Antigravity quota |
| `gemini-3.5-pro-low` | Antigravity quota |
| `gemini-3.5-flash` | Antigravity quota |
| `claude-sonnet-4-6-thinking` | Antigravity quota |
| `claude-opus-4-6-thinking` | Antigravity quota |
| `gpt-oss-120b-medium` | Antigravity quota |
| `gemini-3.5-pro-preview` | Gemini CLI quota |
| `gemini-3.5-flash-preview` | Gemini CLI quota |
| `gemini-cli-3.5-pro-preview` | Gemini CLI quota |
| `gemini-cli-3.5-flash-preview` | Gemini CLI quota |

### Model Variants
Variants let you change thinking mode/level per model.
```bash
pi --provider antigravity --model gemini-3.5-pro-high
pi --provider antigravity --model gemini-3.5-pro-low
pi --provider antigravity --model claude-opus-4-6-thinking
```

---

## Configuration & Usage

All configuration settings are saved in:
```text
~/.pi/agent/antigravity.json
```

### Configuration Commands

- **Show Config**: Show active settings.
  ```text
  /antigravity-config
  ```
- **Set Options**: Set specific configuration parameters.
  ```text
  /antigravity-config accountSelectionStrategy=round-robin
  /antigravity-config accountSelectionStrategy=random
  /antigravity-config accountSelectionStrategy=sticky
  /antigravity-config rotateAccounts=true
  /antigravity-config geminiQuota=auto
  /antigravity-config geminiQuota=gemini-cli
  /antigravity-config geminiQuota=antigravity
  /antigravity-config quotaFallback=true
  ```

### Configuration Options

| Option | Values | Meaning |
|---|---|---|
| `accountSelectionStrategy` | `round-robin`, `random`, `sticky` | How to select accounts. |
| `rotateAccounts` | `true`, `false` | Advance the active account after a successful request. |
| `geminiQuota` | `auto`, `gemini-cli`, `antigravity` | Preferred Gemini quota family. |
| `quotaFallback` | `true`, `false` | Try the other Gemini quota if the preferred quota fails/rate-limits. |
| `quiet` | `true`, `false` | Reserved for future UI verbosity controls. |

### Account Operations

- **Import from Opencode**: Copies `~/.config/opencode/antigravity-accounts.json` to `~/.pi/agent/antigravity-accounts.json` if you already use `opencode-antigravity-auth`.
  ```text
  /antigravity-import-opencode
  ```
- **Show Accounts**: List active imported accounts (emails only).
  ```text
  /antigravity-accounts
  ```

### Enable / Disable Extension
- **Via UI**: Use Pi's package configuration interface:
  ```bash
  pi config
  ```
- **Via Terminal (Disable)**: Rename the active extension folder:
  ```bash
  mv ~/.pi/agent/extensions/antigravity-auth ~/.pi/agent/extensions/antigravity-auth.disabled
  ```
- **Via Terminal (Enable)**: Rename back:
  ```bash
  mv ~/.pi/agent/extensions/antigravity-auth.disabled ~/.pi/agent/extensions/antigravity-auth
  ```

---

## Troubleshooting

- If `pi --list-models antigravity` fails, run `pi config` and ensure the package is enabled.
- If an account stops working, re-authenticate with `/login antigravity`.
- If you imported opencode accounts, use `/antigravity-import-opencode` again after updating the source file.

---

## Development

```bash
git clone https://github.com/WindowsRefundDay/pi-antigravity-auth
cd pi-antigravity-auth
npm install
npm run typecheck
npm run test:list-models
npm run test:smoke
```

---

## Credits & License

- **Credits**: This extension adapts request/response transformation logic from [`opencode-antigravity-auth`](https://github.com/NoeFabris/opencode-antigravity-auth) for Pi.
- **License**: MIT
