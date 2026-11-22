/* Runs every fixture against every configured provider and prints a scorecard.
 *   npm run eval -- --mock                 harness self-check with an offline oracle "provider"
 *   npm run eval -- --config eval.config.json   real providers (keys from env vars)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runAudit } from "../extension/src/background/audit";
import { requestPlan } from "../extension/src/background/planner";
import { buildPayload } from "../extension/src/minimize";
import { createProvider } from "../extension/src/llm";
import { defaultConfig } from "../extension/src/llm/config";
import type { LLMConfig, LLMProvider, ProviderId } from "../extension/src/llm/types";
import type { AuditLLMOutput } from "../extension/src/shared/schemas";
import type { Payload } from "../extension/src/shared/types";
import { auditCases, plannerCases, type AuditCase, type PlannerCase } from "../fixtures/eval";

interface ProviderEntry { name: string; provider: LLMProvider; cfg: LLMConfig }

// ---------------------------------------------------------------- providers
function loadProviders(argv: string[]): ProviderEntry[] {
  if (argv.includes("--mock")) {
    const cfg = { ...defaultConfig("anthropic"), api_key: "mock", model: "oracle" };
    return [{ name: "mock-oracle", provider: oracle(), cfg }];
  }
  const path = argv[argv.indexOf("--config") + 1] ?? "eval.config.json";
  const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: string; provider: ProviderId; base_url?: string; model: string; api_key_env?: string }[];
  return raw.map((r) => {
    const key = r.api_key_env ? process.env[r.api_key_env] ?? "" : "";
    if (r.api_key_env && !key) console.error(`! ${r.name ?? r.provider}: env ${r.api_key_env} is not set`);
    const cfg: LLMConfig = { ...defaultConfig(r.provider), ...(r.base_url ? { base_url: r.base_url } : {}), model: r.model, api_key: key, max_output_tokens: 4000 };
    return { name: r.name ?? `${r.provider}/${r.model}`, provider: createProvider(cfg), cfg };
  });
}

/** Offline stand-in that answers correctly: proves the harness and scoring work without network or keys. */
function oracle(): LLMProvider {
  return {
    async complete({ system, user }) {
      if (system.includes("web-analytics consultant")) {
        const ctx = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
        const c = plannerCases.find((p) => p.context.domain === ctx.domain)!;
        return JSON.stringify(c.gold);
      }
      const p = JSON.parse(user.slice(user.indexOf("{"))) as Payload;
      const out: AuditLLMOutput = {
        summary: { headline: "Oracle review." },
        findings: [],
        rule_reviews: p.rule_findings.map((f) => ({ rule_id: f.id, verdict: "confirmed" as const, explanation: "Confirmed from payload.", evidence: [] })),
      };
      const invalid = p.session.markers.find((m) => /left empty|validation/i.test(m.name));
      if (invalid) {
        out.findings.push({
          severity: "high", vendor: "ga4", category: "wrong_value", title: "generate_lead fired on an invalid form submission",
          detail: `The user was submitting the form with required fields left empty (${invalid.id}), yet generate_lead fired.`,
          evidence: [p.events.find((e) => e.event === "generate_lead")!.id], recommendation: "Fire generate_lead only after successful server-side validation.",
        });
      }
      return JSON.stringify(out);
    },
  };
}

// ---------------------------------------------------------------- scoring
interface PlannerScore { ok: boolean; error?: string; site_type_ok?: boolean; recall?: number; attempts?: number }
async function scorePlanner(p: ProviderEntry, c: PlannerCase): Promise<PlannerScore> {
  try {
    const { plan, attempts } = await requestPlan(p.provider, c.context);
    const want = new Set(c.gold.journeys.flatMap((j) => j.steps.flatMap((s) => s.expect.map((x) => x.event))));
    const got = new Set(plan.journeys.flatMap((j) => j.steps.flatMap((s) => s.expect.map((x) => x.event))));
    const hit = [...want].filter((e) => got.has(e)).length;
    return { ok: true, attempts, site_type_ok: plan.site_type === c.site_type, recall: want.size ? hit / want.size : 1 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface AuditScore {
  llm_status: string; error?: string; faults: number; found: number; llm_faults: number; llm_found: number;
  false_positives: number; dropped: number; dropped_reasons: string[];
}
async function scoreAudit(p: ProviderEntry, c: AuditCase): Promise<AuditScore> {
  const payload = buildPayload({ session: c.session, events: c.events, plan: c.plan });
  const report = await runAudit({ loadConfig: async () => p.cfg, provider: () => p.provider, now: () => Date.now() }, "eval", payload, true);
  const llmText = (f: { title: string; detail?: string }) => `${f.title} ${f.detail ?? ""}`;
  let found = 0, llmFound = 0, llmFaults = 0;
  for (const f of c.faults) {
    if (f.rule) {
      if (report.findings.some((x) => x.source === "rule" && x.category === f.rule!.category && (!f.rule!.title || f.rule!.title.test(x.title)))) found++;
    }
    if (f.llm) {
      llmFaults++;
      if (report.findings.some((x) => x.source === "llm" && f.llm!.text.test(llmText(x)))) { found++; llmFound++; }
    }
  }
  const fp = c.clean ? report.findings.filter((x) => x.source === "llm" && (x.severity === "critical" || x.severity === "high")).length : 0;
  return { llm_status: report.llm.status, error: report.llm.error, faults: c.faults.length, found, llm_faults: llmFaults, llm_found: llmFound, false_positives: fp, dropped: report.llm.dropped_findings, dropped_reasons: report.llm.dropped_reasons };
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const providers = loadProviders(argv);
  const results: Record<string, { planner: Record<string, PlannerScore>; audit: Record<string, AuditScore> }> = {};

  for (const p of providers) {
    process.stderr.write(`\n== ${p.name}\n`);
    const planner: Record<string, PlannerScore> = {};
    const audit: Record<string, AuditScore> = {};
    for (const c of plannerCases) { process.stderr.write(`  plan  ${c.name}\n`); planner[c.name] = await scorePlanner(p, c); }
    for (const c of auditCases()) { process.stderr.write(`  audit ${c.name}\n`); audit[c.name] = await scoreAudit(p, c); }
    results[p.name] = { planner, audit };
  }

  // ---- scorecard
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  console.log("\nPLANNER   (site type correct / recall of gold events)");
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name.padEnd(28)} ` + plannerCases.map((c) => { const s = r.planner[c.name]; return `${c.name}: ${s.ok ? `${s.site_type_ok ? "type✓" : "type✗"} ${pct(s.recall ?? 0)}` : "FAILED"}`; }).join(" | "));
  }
  console.log("\nAUDIT     (faults found / LLM-only faults found / false positives / dropped findings)");
  for (const [name, r] of Object.entries(results)) {
    const rows = Object.values(r.audit);
    const sum = (k: keyof AuditScore) => rows.reduce((n, x) => n + (typeof x[k] === "number" ? (x[k] as number) : 0), 0);
    console.log(`  ${name.padEnd(28)} faults ${sum("found")}/${sum("faults")} | llm-only ${sum("llm_found")}/${sum("llm_faults")} | false+ ${sum("false_positives")} | dropped ${sum("dropped")} | llm failed on ${rows.filter((x) => x.llm_status !== "ok").length}/${rows.length}`);
  }

  // ---- gates from the plan
  const gates: { name: string; pass: boolean; detail: string }[] = [];
  const names = Object.keys(results);
  const plannerPass = names.filter((n) => plannerCases.every((c) => results[n].planner[c.name].ok && results[n].planner[c.name].site_type_ok && (results[n].planner[c.name].recall ?? 0) >= 0.75));
  gates.push({ name: "T4: right site type + sensible events on all 3 fixtures", pass: plannerPass.length >= Math.min(3, names.length), detail: `${plannerPass.length}/${names.length} providers pass (need ≥ 3 of 4)` });
  const faultsMissed = names.flatMap((n) => Object.entries(results[n].audit).filter(([, s]) => s.found < s.faults).map(([c]) => `${n}:${c}`));
  gates.push({ name: "T5: seeded faults found on every provider", pass: faultsMissed.length === 0, detail: faultsMissed.length ? `missed ${faultsMissed.join(", ")}` : "all found" });
  const bad = names.flatMap((n) => Object.entries(results[n].audit).filter(([, s]) => s.dropped_reasons.some((r) => /unknown event id/.test(r))).map(([c]) => `${n}:${c}`));
  gates.push({ name: "T5: no finding cites an event ID that isn't in the payload", pass: bad.length === 0, detail: bad.length ? `unknown IDs cited in ${bad.join(", ")}` : "none" });
  console.log("\nGATES");
  for (const g of gates) console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}`);

  mkdirSync(".eval", { recursive: true });
  const out = `.eval/results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ results, gates }, null, 2));
  console.log(`\nSaved ${out}`);
  process.exit(gates.every((g) => g.pass) ? 0 : 1);
}

void main();
