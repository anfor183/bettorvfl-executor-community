// Settings may arrive as JSON booleans or CLI strings. Never treat "false" as true.
function parseBooleanSetting(value, fallback = false) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function resolveExecutorStartOptions(settings, options = {}) {
  const platform = String(options.platform || settings.betExecutorPlatform || 'sportybet').toLowerCase();
  const stored = platform === 'sportybet' ? settings.sportybetExecutor : settings.betExecutor;
  const resolved = { ...stored, ...options, platform };
  resolved.autoBet = parseBooleanSetting(options.autoBet, parseBooleanSetting(stored?.autoBet, platform === 'sportybet'));
  return resolved;
}

module.exports = { parseBooleanSetting, resolveExecutorStartOptions };
