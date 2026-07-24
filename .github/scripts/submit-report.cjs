const fs = require('fs');
const path = require('path');

module.exports = { run, formatFindings };

const MARKER = '<!-- reviewdog-summary -->';

function formatFindings(allFindings) {
  let body = '<h1>Code Quality Report</h1>\n\n';

  if (allFindings.length > 0) {
    const hasErrors = allFindings.some(f => f.severity === 'ERROR');
    const hasWarnings = allFindings.some(f => f.severity === 'WARNING');
    body += '<details open><summary><h2>'
         + (hasErrors ? '❌ ERROR' : hasWarnings ? '🟡 WARNING' : '☑️ NOTICE')
         + '</h2></summary>\n\n';
    body += '<h3>Details:</h3>\n\n';
  } else {
    body += '✅ PASS\n\n';
  }

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
      body += `<details open>\n<summary>${icon} ${label} (${fs.length})</summary>\n\n`;
      body += '| Location | Message |\n';
      body += '|----------|---------|\n';
      for (const f of fs) {
        const source = (f.source && f.source.name) || 'Unknown';
        const file = (f.location && f.location.path) || 'unknown';
        const line = (f.location && f.location.range && f.location.range.start && f.location.range.start.line) || '?';
        const msg = f.message || '';
        body += `| \`${file}:${line}\` | ${msg} |\n`;
      }
      body += '\n</details>\n\n';
    }

    body += '</details>\n';
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
    for (const c of comments) {
      if (c.body && c.body.includes(MARKER)) {
        await github.rest.issues.updateComment({
          ...context.repo,
          comment_id: c.id,
          body: c.body.replace(/<details open>/g, '<details>'),
        });
      }
    }
  }
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: context.issue.number,
    body,
  });

  const hasErrors = allFindings.some(f => f.severity === 'ERROR');
  const hasWarnings = allFindings.some(f => f.severity === 'WARNING');
  if (hasErrors || hasWarnings) {
    throw new Error('Code Quality Report: ' + (hasErrors ? 'errors' : 'warnings') + ' found');
  }
}