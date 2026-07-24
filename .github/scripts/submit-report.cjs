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
         + (hasErrors ? '❌ ERROR' : hasWarnings ? '🟡 WARNING' : '❎ NOTICE')
         + '</h2></summary>\n';
    body += '<h2>Details:</h2>\n';
  } else {
    body += '<details open><summary><h2>✅ PASS</h2></summary>\n\n';
    body += '<h3>No issues found.</h3>\n\n';
    body += '</details>\n';
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
      const fileGroups = {};
      for (const f of fs) {
        const file = (f.location && f.location.path) || 'unknown';
        if (!fileGroups[file]) fileGroups[file] = [];
        fileGroups[file].push(f);
      }

      body += `<h3>${icon} ${label} (${fs.length})</h3>\n`;
      for (const [file, findings] of Object.entries(fileGroups)) {
        body += `<b>${file}:</b>\n<pre>\n`;
        for (const f of findings) {
          const line = (f.location && f.location.range && f.location.range.start && f.location.range.start.line) || '?';
          const msg = f.message || '';
          body += `Line ${line}: ${msg}\n`;
        }
        body += `</pre>\n`;
      }
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

  const lastReport = [...comments].reverse().find(c => c.body && c.body.includes(MARKER));
  if (lastReport && lastReport.body === body) {
    return body;
  }

  const existing = comments.find(c => c.body && c.body.includes(MARKER));

  if (existing) {
    for (const c of comments) {
      if (c.body && c.body.includes(MARKER)) {
        const openTag = '<details open><summary><h2>';
        const body = c.body.includes(openTag)
          ? c.body.replace(openTag, '<details><summary><h2>')
          : c.body;
        await github.rest.issues.updateComment({
          ...context.repo,
          comment_id: c.id,
          body,
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