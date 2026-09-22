// Classic PreCompact hook, installed in ~/.claude/settings.json (not by the plugin,
// so it keeps working when the plugin fails to load).
//
// Claude Code runs PreCompact hooks inside its own compaction core: manual
// /compact, reactive auto-compaction and precompute alike, before it asks the
// model for a summary. Core is reached only when no session.compact function
// hook answered, i.e. when fast-jev did not run. Exit code 2 blocks: the
// conversation stays as it is and the reason is shown. Jev compaction never
// gets here, so it is not affected.
process.stderr.write(
  'fast-jev: the built-in Claude summary is switched off. This means the fast-jev plugin did not ' +
    'handle this compaction (not loaded?). Open a new Code chat and look for the "fast-jev" toast on /compact.',
);
process.exit(2);
