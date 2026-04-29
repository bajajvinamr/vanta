#!/usr/bin/env node
// PreToolUse on Write|Edit — detect writes to security/architecture-critical
// paths and inject a /council advisory before the write proceeds.
// Fires on: auth, payments, migrations, security middleware, infra code.
// Small fixes in these files are fine — this is a nudge, not a block.

const COUNCIL_TRIGGERS = [
  { re: /\/(auth|authn|authz|authentication|authorization|oauth|jwt|token|credential|password)([\/.]|$)/i, reason: 'auth/credential code' },
  { re: /\/sessions?([\/.]|$)/i, reason: 'auth/session code' },
  { re: /\/(payment|billing|stripe|subscription|checkout)/i, reason: 'payment/billing code' },
  { re: /\/(admin|privilege|rbac|role)\//i, reason: 'access-control code' },
  { re: /\/migrations?\//i, reason: 'database migration' },
  { re: /schema\.prisma$/i, reason: 'database schema' },
  { re: /\/(middleware|security|cors|helmet)\//i, reason: 'security middleware' },
  { re: /\/(infrastructure|terraform|k8s|kubernetes)\//i, reason: 'infrastructure code' },
];

function extractFilePath(data) {
  return String(data.tool_input?.file_path || data.tool_input?.path || '');
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const filePath = extractFilePath(data);
    if (!filePath) process.exit(0);

    const normalized = filePath.replace(/\\/g, '/');

    let trigger = null;
    for (const t of COUNCIL_TRIGGERS) {
      if (t.re.test(normalized)) {
        trigger = t;
        break;
      }
    }

    if (!trigger) process.exit(0);

    const result = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `COUNCIL ADVISORY: Editing ${trigger.reason} — ${filePath}. ` +
          `If this change introduces a new flow (not a small fix), run /council first. ` +
          `Non-trivial changes to auth/payments/migrations/security are exactly what /council catches.`,
      },
    };

    process.stdout.write(JSON.stringify(result));
  } catch (_) {
    process.exit(0);
  }
});
