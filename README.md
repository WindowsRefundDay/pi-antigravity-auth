# pi-antigravity-auth

Pi Coding Agent provider extension for Google Antigravity OAuth models with multi-account rotation.

> **Warning**
>
> This project uses Google OAuth credentials and local account tokens. It may affect provider quotas, account standing, or ToS compliance. Use at your own risk.
>
## What you get

- **Google OAuth sign-in** with automatic token refresh
- **Multi-account rotation**
- **Real-time SSE streaming** with tool calls and thinking blocks
- **Variant-style thinking control**
- **Automatic import** from `opencode-antigravity-auth`
- **Native Pi provider integration**

---

## Getting Started

### 1. Installation

#### Agent install

Copy and paste the text block below directly into your Pi chat. The Pi coding agent will automatically download and install the extension, then show you the commands to authenticate:

```text
Please install the `pi-antigravity-auth` extension. Run the following command in the terminal to download and install it:

pi install git:github.com/WindowsRefundDay/pi-antigravity-auth

After the installation command finishes successfully, tell me to run these commands in the chat to complete the authentication:
1. `/reload` (to reload the environment and load the new extension)
2. `/login antigravity` (to authenticate via Google OAuth)
```

<!--
🤖 AGENT INSTRUCTIONS:
You are an AI assistant helping the user install the `pi-antigravity-auth` extension for their Pi environment.
Follow these steps strictly:

1. **INSTALLATION**: Run the following terminal command to install the extension from GitHub:
   `pi install git:github.com/WindowsRefundDay/pi-antigravity-auth`

2. **USER HANDOFF**: Because you cannot execute interactive slash commands or complete browser OAuth flows yourself, you MUST stop here. In your final response, explicitly instruct the user to run the following two commands in their chat/terminal to complete setup:
   - Type `/reload` to restart the Pi environment.
   - Type `/login antigravity` to open the Google OAuth browser window and authenticate.

Do not attempt to run the slash commands yourself. Provide them as text for the user to run.
-->

#### Normal install
Run the installation command in your terminal:
```bash
pi install git:github.com/WindowsRefundDay/pi-antigravity-auth
```
Then restart your Pi environment:
```text
/reload
```

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

### Gemini 3.6 Flash

`gemini-3.6-flash-{low,medium,high}` routes through the main Antigravity quota. The IDs match the model IDs exposed by the official `agy models` command; use the suffix to select the Antigravity reasoning tier. These are the recommended Gemini Flash models for new Pi sessions.

```bash
pi --provider antigravity --model gemini-3.6-flash-medium
```

### Available Models

| Model | Notes |
|---|---|
| `gemini-3.6-flash-high` | Current Antigravity quota model |
| `gemini-3.6-flash-medium` | Current Antigravity quota model |
| `gemini-3.6-flash-low` | Current Antigravity quota model |
| `gemini-3.1-pro-high` | Antigravity quota |
| `gemini-3.1-pro-low` | Antigravity quota |
| `gemini-3-flash` | Antigravity quota |
| `claude-sonnet-4-6-thinking` | Antigravity quota |
| `claude-opus-4-6-thinking` | Antigravity quota |
| `gpt-oss-120b-medium` | Antigravity quota |

### Model Variants
Variants let you change thinking mode/level per model.
```bash
pi --provider antigravity --model gemini-3.6-flash-high
pi --provider antigravity --model gemini-3.6-flash-medium
pi --provider antigravity --model gemini-3.1-pro-high
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
- **Set Options**: Set specific configuration parameters using clean, short aliases (or backward-compatible long names).
  ```text
  /antigravity-config strategy=round-robin
  /antigravity-config strategy=random
  /antigravity-config strategy=sticky
  /antigravity-config rotate=true
  /antigravity-config quiet=true
  ```

### Configuration Options

The extension supports fine-tuned control over account cycling and quota fallback behavior. Below is a detailed breakdown of all available settings (both short aliases and backward-compatible long names are supported):

| Option / Short Name | Full Option / Alias | Type / Values | Default | Description & Details |
| :--- | :--- | :--- | :--- | :--- |
| `strategy` | `accountSelectionStrategy` | `round-robin`, `random`, `sticky` | `round-robin` | Controls how the active account is selected from the authenticated pool.<br/><br/>**Behavior:**<br/>• `round-robin` *(Recommended)*: Cycles sequentially through all active accounts to evenly distribute load and help maximize overall token/request limits.<br/>• `random`: Dynamically chooses an account at random for each request.<br/>• `sticky`: Continues using the last successfully used account for consecutive requests, minimizing frequent account hops. |
| `rotate` | `rotateAccounts` | `true`, `false` | `true` | Controls whether the active account pointer advances after a successful operation.<br/><br/>**Behavior:**<br/>• `true`: Once a request succeeds, the active pointer shifts, ensuring the next request uses the next account according to the selection strategy.<br/>• `false`: The current account remains active indefinitely until it encounters a failure or rate limit, at which point rotation logic takes over. |
| `quiet` | `quiet` | `true`, `false` | `false` | Controls extension status output. |


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
