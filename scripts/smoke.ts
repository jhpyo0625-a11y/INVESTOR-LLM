import { runTool } from "../src/tools/index";
import { runAgent } from "../src/agent/engine";
import { route, buildInitialMessage } from "../src/agent/orchestrator";

const today = new Date().toISOString().slice(0, 10);
const dartDay = today.replaceAll("-", "");

async function tools() {
  const checks: [string, unknown][] = [
    ["get_stock_data", { ticker: "005930" }],
    ["search_disclosures", { dateFrom: dartDay, dateTo: dartDay }],
    ["get_market_overview", { date: today }],
    ["web_search", { query: "삼성전자 주가 전망", maxResults: 3 }],
  ];
  let failed = 0;
  for (const [name, args] of checks) {
    const r = await runTool(name, args);
    const summary = r.ok ? JSON.stringify(r.data).slice(0, 200) : `ERROR: ${r.error}`;
    if (!r.ok) failed++;
    console.log(`\n[${r.ok ? "OK " : "FAIL"}] ${name}\n  ${summary}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} tools OK`);
  process.exit(failed ? 1 : 0);
}

async function agent(ticker = "005930") {
  const req = { mode: "company" as const, target: ticker, option: "A" as const };
  const specialist = route(req)!;
  console.log(`specialist: ${specialist.key}\n`);
  for await (const e of runAgent(specialist, [{ role: "user", content: buildInitialMessage(req) }])) {
    if (e.type === "token") process.stdout.write(e.text);
    else if (e.type === "action") console.log(`\n\n>> ACTION ${e.tool} ${JSON.stringify(e.args)}`);
    else if (e.type === "observation")
      console.log(`>> OBSERVATION ${e.tool} ${e.result.ok ? "ok" : `FAIL: ${e.result.error}`}\n`);
    else if (e.type === "error") console.error(`\n!! ERROR (retryable=${e.retryable}): ${e.message}`);
    else if (e.type === "done") console.log("\n\n== done ==");
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "tools") tools();
else if (cmd === "agent") agent(arg);
else console.log("usage: npm run smoke tools | npm run smoke agent [ticker]");
