import type { AuditReport, Finding } from "../shared/types";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function reportToMarkdown(r: AuditReport): string {
  const L: string[] = [];
  L.push(`# IntelliTrack audit`, "");
  L.push(`**Score: ${r.score}/100** · ${r.headline}`, "");
  L.push(
    `- Session: \`${r.session_id}\``,
    `- Generated: ${new Date(r.created_at).toISOString()}`,
    r.llm.status === "ok"
      ? `- LLM review: ${r.llm.provider} / ${r.llm.model} (${r.llm.prompt_version}${r.llm.attempts === 2 ? ", needed one retry" : ""})`
      : r.llm.status === "failed"
        ? `- LLM review: **failed** (${r.llm.error ?? "unknown error"}). Rule findings only.`
        : `- LLM review: not requested. Rule findings only.`,
    "",
  );
  if (r.llm.dropped_findings > 0) {
    L.push(`> ${r.llm.dropped_findings} LLM finding(s) were discarded: ${r.llm.dropped_reasons.map(esc).join("; ")}`, "");
  }

  if (r.plan) {
    L.push(`## Audited against this plan`, "", `Site type: **${r.plan.site_type}**${r.plan.rationale ? `: ${r.plan.rationale}` : ""}`, "");
    for (const j of r.plan.journeys) {
      L.push(`- **${j.id} ${j.name}**: ${j.steps.map((s) => `${s.id} ${s.name} (${s.expect.map((x) => x.event).join(", ")})`).join(" → ")}`);
    }
    L.push("");
  }

  if (r.journey_coverage.length) {
    L.push(`## Journey coverage`, "", `| Journey | Step | Expected | Observed | Status |`, `|---|---|---|---|---|`);
    for (const c of r.journey_coverage) {
      L.push(`| ${c.journey} | ${esc(`${c.step} ${c.step_name}`)} | ${esc(c.expected.join(", "))} | ${esc(c.observed.join(", ") || "-")} | ${c.status} |`);
    }
    L.push("");
  }

  L.push(`## Findings (${r.findings.length})`, "");
  if (r.findings.length === 0) L.push("No findings.", "");
  // X2: consent findings are a legal risk, not hygiene, so they lead the list regardless of severity.
  const consentFindings = r.findings.filter((f) => f.category === "consent");
  if (consentFindings.length) {
    L.push(`### Consent (${consentFindings.length})`, "");
    for (const f of consentFindings) L.push(...findingMd(f));
  }
  for (const sev of SEVERITIES) {
    const fs = r.findings.filter((f) => f.severity === sev && f.category !== "consent");
    if (!fs.length) continue;
    L.push(`### ${sev[0].toUpperCase()}${sev.slice(1)} (${fs.length})`, "");
    for (const f of fs) L.push(...findingMd(f));
  }

  L.push(`## Capture stats`, "", `- Events captured: ${r.stats.raw_events}`);
  const noise = Object.entries(r.stats.noise_counts);
  if (noise.length) L.push(`- Heartbeat events not listed: ${noise.map(([k, v]) => `${k} ×${v}`).join(", ")}`);
  L.push(`- Near-duplicates removed: ${r.stats.duplicates_dropped}`, "");
  return L.join("\n");
}

function findingMd(f: Finding): string[] {
  const out = [`#### ${f.id} · ${f.title}`, "", `Source: ${f.source === "rule" ? "rule engine" : "LLM"} · Category: ${f.category} · Vendor: ${f.vendor}`, "", f.detail, ""];
  if (f.evidence.length) out.push(`Evidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}`, "");
  out.push(`**Fix:** ${f.recommendation}`, "");
  if (f.review) out.push(`*LLM review (${f.review.verdict}):* ${f.review.explanation}`, "");
  return out;
}
