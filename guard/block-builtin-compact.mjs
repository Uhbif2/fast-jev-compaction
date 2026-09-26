// Classic PreCompact hook, installed in ~/.claude/settings.json (not by the plugin,
// so it keeps working when the plugin fails to load).
//
// Claude Code runs PreCompact hooks inside its own compaction core: manual
// /compact, reactive auto-compaction and precompute alike, before it asks the
// model for a summary. Core is reached only when no session.compact function
// hook answered, i.e. when fast-jev did not run. Exit code 2 blocks: the
// conversation stays as it is and the reason is shown. Jev compaction never
// gets here, so it is not affected.
//
// Each block is appended to <config>/fast-jev-guard.log (time, session,
// trigger; never content), since the reason the plugin did not answer is
// otherwise gone by the time anyone looks.
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const now = new Date();
let event = {};
try {
  event = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  // An unreadable event still blocks.
}
try {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  appendFileSync(
    join(config, 'fast-jev-guard.log'),
    JSON.stringify({
      at: now.toISOString(),
      session: event.session_id,
      trigger: event.trigger,
      cwd: event.cwd,
      parentPid: process.ppid,
    }) + '\n',
  );
} catch {
  // Logging is best effort; blocking is not.
}
const time = now.toTimeString().slice(0, 5);
process.stderr.write(
  `fast-jev [${time}]: the built-in Claude summary is switched off, and the fast-jev plugin did not ` +
    'handle this compaction (not loaded in this runtime?). Recorded in ~/.claude/fast-jev-guard.log. ' +
    'Try /compact again; if it repeats, open a new Code chat and look for the "fast-jev" toast.',
);
process.exit(2);
