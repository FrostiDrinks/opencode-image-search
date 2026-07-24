const fs = require('fs');

module.exports = { run };

async function run({ github, context }) {
  const findings = [];
  const { data: files } = await github.rest.pulls.listFiles({
    ...context.repo,
    pull_number: context.issue.number,
  });

  const modified = files.map(f => f.filename);
  const srcChanges = modified.filter(f => f.startsWith('src/'));
  const testChanges = modified.filter(f => f.endsWith('.test.ts'));

  if (srcChanges.length > 0 && testChanges.length === 0) {
    findings.push({
      message: 'Source files under `src/` were modified, but no test file (`*.test.ts`) appears in these changes. Please verify test coverage for compliancy.',
      location: { path: srcChanges[0], range: { start: { line: 1 } } },
      severity: 'INFO',
    });
  }

  const pkgFile = files.find(f => f.filename === 'package.json');
  const lockChanged = modified.includes('bun.lock');
  if (pkgFile && !lockChanged) {
    const depFields = ['"dependencies"', '"devDependencies"', '"peerDependencies"', '"optionalDependencies"', '"overrides"'];
    const patch = pkgFile.patch || '';
    const depsTouched = depFields.some(f => patch.includes(f));
    if (depsTouched) {
      findings.push({
        message: '`package.json` dependency fields were changed but `bun.lock` was not updated. Run `bun install` to update the lockfile.',
        location: { path: 'package.json', range: { start: { line: 1 } } },
        severity: 'ERROR',
      });
    }
  }

  const report = findings.map(f => JSON.stringify({ source: { name: 'check-files' }, ...f })).join('\n');
  fs.writeFileSync('.reviewdog-report.jsonl', report);
}
