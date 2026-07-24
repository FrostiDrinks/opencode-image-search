const fs = require('fs');
const path = require('path');

module.exports = { run, formatFindings };

const MARKER = '<!-- reviewdog-summary -->';

function formatFindings(allFindings) {
  if (allFindings.length === 0) {
    return '## Code Quality Report\n\nNo issues found.\n\n' + MARKER;
  }

  const grouped = {};
  for (const f of allFindings) {
    const name = (f.source && f.source.name) || 'Unknown';
    if (!grouped[name]) grouped[name] = [];
    grouped[name].push(f);
  }

  let body = '## Code Quality Report\n\n';
  for (const [name, fs] of Object.entries(grouped)) {
    const icon = fs.some(f => f.severity === 'ERROR') ? '🔴' :
                fs.some(f => f.severity === 'WARNING') ? '🟡' : '🔵';
    body += `### ${icon} ${name} (${fs.length})\n\n`;
    body += '| File | Line | Severity | Message |\n';
    body += '|------|------|----------|---------|\n';
    for (const f of fs) {
      const file = (f.location && f.location.path) || 'unknown';
      const line = (f.location && f.location.range && f.location.range.start && f.location.range.start.line) || '?';
      const sev = f.severity || 'INFO';
      const msg = f.message || '';
      body += `| \`${file}\` | ${line} | ${sev} | ${msg} |\n`;
    }
    body += '\n';
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
    await github.rest.issues.updateComment({
      ...context.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: context.issue.number,
      body,
    });
  }
}
