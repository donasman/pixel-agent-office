// Where claude finds Git Bash on Windows (undefined without it). Without Git Bash, claude runs hooks in PowerShell,
// which needs the agent-office-powershell variant of the plugin.
const fs = require('fs');
const path = require('path');

const env = process.env;
module.exports = [env.CLAUDE_CODE_GIT_BASH_PATH, ...['ProgramFiles', 'ProgramFiles(x86)'].map(k => env[k] && path.join(env[k], 'Git', 'bin', 'bash.exe')),
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')].find(p => p && fs.existsSync(p));
