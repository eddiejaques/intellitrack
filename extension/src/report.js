import {app,element,button,send,status,download} from './ui.js';

const id = new URLSearchParams(location.search).get('id');
const pretty = value => JSON.stringify(value,null,2);
const heading = text => element('h2',text);
const json = (label,value,open = false) => {
  const details = element('details');
  details.open = open;
  details.append(element('summary',label),element('pre',pretty(value)));
  return details;
};
function markdown(report) {
  const {summary,journey_coverage:steps,findings,model,plan} = report;
  return [
    '# IntelliTrack audit', '', `Score **${summary.score}/100**`, '', summary.headline, '',
    ...(model ? [`Model **${model.provider} / ${model.model}** (${model.prompt_version})`,''] : []),
    ...(plan ? [`Journey **${plan.name}**`,''] : []),
    '## Journey coverage','',
    ...steps.map(step => `- **${step.name}** · ${step.status} · expected ${step.expected.join(', ')} · observed ${step.observed.join(', ') || 'none'}`),
    '', '## Findings','', ...findings.flatMap(finding => [
      `### ${finding.severity.toUpperCase()} · ${finding.title}`, '',
      finding.detail,'',finding.recommendation,'',
      `Source **${finding.source}**${finding.evidence.length ? ` · Evidence ${finding.evidence.join(', ')}` : ''}`,''
    ])
  ].join('\n');
}
function renderReport(container,report) {
  const groups = ['critical','high','medium','low','info'];
  container.replaceChildren(heading(`Score ${report.summary.score} / 100`),element('p',report.summary.headline),
    ...(report.error ? [element('p',report.error)] : []),
    ...(report.model ? [element('p',`${report.model.provider} · ${report.model.model} · ${report.model.prompt_version}`)] : []),
    button('Export report JSON',() => download('intellitrack-report.json',pretty(report),'application/json')),
    button('Export Markdown',() => download('intellitrack-report.md',markdown(report),'text/markdown')));
  if (report.plan) container.append(heading(report.plan.name),json('Confirmed journey plan',report.plan));
  for (const step of report.journey_coverage) {
    container.append(element('p',`${step.name} · ${step.status} (${step.observed.length}/${step.expected.length})`));
  }
  container.append(heading('Findings'));
  if (!report.findings.length) container.append(element('p','No findings.'));
  for (const severity of groups) {
    const findings = report.findings.filter(finding => finding.severity === severity);
    if (!findings.length) continue;
    container.append(element('h3',severity));
    for (const finding of findings) {
      const row = element('details');
      row.append(element('summary',`${finding.title} · ${finding.source}`),
        element('p',finding.detail),element('p',finding.recommendation));
      if (finding.evidence.length) row.append(element('p',`Evidence ${finding.evidence.join(', ')}`));
      container.append(row);
    }
  }
}
async function load() {
  const {token,destination,payload,raw,report} = await send('preview',{id});
  const content = element('section');
  app.replaceChildren(element('h1','IntelliTrack audit'),heading('Preview before sending'),
    element('p',destination ?
      `Destination ${destination.provider} (${destination.model}) at ${destination.endpoint}` : 'Set up a provider to request an LLM review.'),
    json('Minimized session JSON',payload,true),
    button('Export session JSON',() => download('intellitrack-session.json',pretty(payload),'application/json')));
  if (destination) {
    const confirm = button('Send this preview',async () => {
      status('Reviewing audit…');
      const result = await send('audit',{id,token});
      renderReport(content,result);
      confirm.remove();
      status('');
    });
    app.append(confirm);
  }
  app.append(content,json('Raw captured events · local only',raw));
  renderReport(content,report);
}
await load().catch(error => status(error.message));
