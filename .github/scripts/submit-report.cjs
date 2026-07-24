const fs = require('fs');
const path = require('path');

module.exports = { run, formatFindings };

const MARKER = '<!-- reviewdog-summary -->';

function formatFindings(allFindings) {
  let body = '## Code Quality Report\n\n';

  if (allFindings.length > 0) {
    const errs = allFindings.filter(f => f.severity === 'ERROR').length;
    const warns = allFindings.filter(f => f.severity === 'WARNING').length;
    const infos = allFindings.length - errs - warns;
    if (errs > 0) body += '🛑 ' + errs + ' error(s)\n';
    if (warns > 0) body += '⚠️ ' + warns + ' warning(s)\n';
    if (infos > 0) body += '📄 ' + infos + ' notice(s)\n';
    body += '\n';
  } else {
    body += 'All checks passed.\n\n';
  }

  body += '---\n\n';

  if (allFindings.length > 0) {
    const groups = { ERROR: [], WARNING: [], 'Non-blocker': [] };
    for (const f of allFindings) {
      const key = f.severity === 'ERROR' ? 'ERROR' : f.severity === 'WARNING' ? 'WARNING' : 'Non-blocker';
      groups[key].push(f);
    }

    const labels = [
      { key: 'ERROR', icon: '🛑', label: 'Errors' },
      { key: 'WARNING', icon: '⚠️', label: 'Warnings' },
      { key: 'Non-blocker', icon: '📄', label: 'Notices' },
    ];

    for (const { key, icon, label } of labels) {
      const fs = groups[key];
      if (fs.length === 0) continue;
      body += `<details>\n<summary>${icon} ${label} (${fs.length})</summary>\n\n`;
      body += '| Source | File | Line | Message |\n';
      body += '|--------|------|------|---------|\n';
      for (const f of fs) {
        const source = (f.source && f.source.name) || 'Unknown';
        const file = (f.location && f.location.path) || 'unknown';
        const line = (f.location && f.location.range && f.location.range.start && f.location.range.start.line) || '?';
        const msg = f.message || '';
        body += `| ${source} | \`${file}\` | ${line} | ${msg} |\n`;
      }
      body += '\n</details>\n\n';
    }
  }

  return body + MARKER;
}

async function run({ github, context, dryRun, findingsDir }) {
  if (!findingsDir) {
    findingsDir = path.join(process.env.GITHUB_WORKSPACE, 'findings');
  }
  let allFindings = [];

  if (fs.existsSync(findingsDir)) {
    for (const file of fs.readdirSync(findingsDir)) {
      const content = fs.readFileSync(path.join(findingsDir, file), 'utf-8').trim();
      if (!content) continue;
      for (const line of content.split('\n')) {
        try { allFindings.push(JSON.parse(line)); } catch {}
      }
    }
  }

  const body = formatFindings(allFindings);

  if (dryRun) {
    console.log(body);
    return body;
  }

  const { data: comments } = await github.rest.issues.listComments({
    ...context.repo,
    issue_number: context.issue.number,
  });
  const existing = comments.find(c => c.body && c.body.includes(MARKER));

  if (existing) {
    const sepIdx = existing.body.indexOf('\n---\n');
    if (sepIdx !== -1) {
      const summary = existing.body.slice(0, sepIdx).trim();
      const content = existing.body.slice(sepIdx + 5).trim().replace(MARKER, '').trim();
      let collapsed = summary + '\n\n---\n\n';
      if (content) {
        collapsed += '<details>\n\n' + content + '\n\n</details>';
      }
      await github.rest.issues.updateComment({
        ...context.repo,
        comment_id: existing.id,
        body: collapsed,
      });
    }
  }
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: context.issue.number,
    body,
  });
}
