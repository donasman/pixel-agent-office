# agent-office (Claude Code plugin)

Shows your Claude Code main agent and its subagents as pixel-art office workers. The plugin only adds hooks: on each event it posts the hook's JSON to the local Agent Office viewer, which you open with `npx pixel-agent-office`. The hooks run in the background and never slow Claude down. When the viewer is not open they exit at once, sending and printing nothing. Nothing leaves your machine.

Needs `bash` and `curl` (on Windows, Claude Code runs hooks in Git Bash, which includes curl). See the repository README for the full guide.
