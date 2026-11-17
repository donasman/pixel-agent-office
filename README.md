# Agent Office

Watch your Claude Code agents work in a pixel-art office. The main agent is the boss. Every subagent is a staff member who wakes up when given a task, works at their desk, sends a report flying to the boss when done, and goes back to sleep.

## Quick start

1. In Claude Code, install the plugin:

   ```
   /plugin marketplace add donasman/pixel-agent-office
   /plugin install agent-office@agent-office
   ```

2. Open the office (Node.js 18 or later):

   ```
   npx pixel-agent-office
   ```

Then use Claude Code as usual, in any terminal or IDE. The office opens in an app window (Edge or Chrome) or in your default browser. Close the window and the viewer stops.

## What happens in the office

| In Claude Code | In the office |
|---|---|
| A subagent starts | A sleeping staff member wakes up with a "!" and gets the task's name |
| Edit / Write, Read / Grep, Bash | Typing, reading papers, a terminal on the monitor |
| A subagent finishes | Its report flies to the boss's desk; the boss reads the first line |
| Permission prompt | A "?" bubble, a chime, and a blinking taskbar (desktop app) |
| A tool fails | Sweat and "OOPS"; three failures in a row make the monitor smoke |
| `git commit` / tests pass | Confetti / the whole office claps |
| Context compaction | A robot vacuum cleans up and the report pile is filed away |
| Rate limit or overload | The lights go out |

Click anyone to see their task, recent tools, work time and last report. Three office themes: day, late night and wood.

Running several claude sessions at once? Each gets its own floor, named after its folder (`1F readme`, `2F blog`). Tabs switch floors, and the view moves to a floor that needs you (a permission prompt) or comes alive while yours is quiet; turn that off with 자동 이동. When a session ends its floor closes, and restarting claude in that folder opens it again.

The art lives in `public/art/`. It is cut out of the pixel-art design by `node tools/import-design.js` (inputs in `tools/design/`).

## How it works

```
Claude Code hooks ──curl──▶ local server (127.0.0.1) ──SSE──▶ office page
        │
        └─ reads ~/.agent-office/port, which exists only while the office is open
```

- The hooks run in the background (`async`), so they never slow Claude down.
- When the office isn't open there is no port file, and the hooks exit at once: nothing is sent and nothing is printed.
- Everything stays on your machine. The server keeps only what the office draws (tool names, task names, a report's first line) and drops file contents and command output. To show the boss's model, it reads the end of the session transcript.

Requirements: `bash` and `curl`. macOS and Linux have both. On Windows, Claude Code runs hooks in Git Bash, which includes curl. On Windows without Git for Windows, Claude Code runs hooks in PowerShell instead: install `agent-office-powershell@agent-office` rather than `agent-office@agent-office`. (The desktop app picks the right one itself.)

## Desktop app with a built-in terminal (optional, Windows)

Claude on the left, the office on the right, in one window:

```
git clone https://github.com/donasman/pixel-agent-office.git
cd pixel-agent-office
npm install
npm start
```

It runs your own `claude` login, so it uses your subscription as usual.

## Uninstall

```
/plugin uninstall agent-office@agent-office
```

and delete the `~/.agent-office` folder.

## Development

```
npm test          # office logic, server, npx entry
npm run viewer    # the viewer from source
npm start         # the desktop app
```

`core/server.js` receives hook events and streams them; `public/` is the office page; `plugin/` is the Claude Code plugin; `electron/` is the desktop app.

## License

[MIT](LICENSE) © donasman
