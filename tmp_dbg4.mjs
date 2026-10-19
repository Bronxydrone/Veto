import { readFileSync } from "node:fs";
import { loadPolicy } from "./src/core/policy.ts";
import { VetoGuard } from "./src/core/service.ts";
const doc = structuredClone(loadPolicy(readFileSync("examples/policy.yaml","utf8")).doc); doc.risk = {};
const PRICES = { NEAR: 2_450_000n, USDC: 1_000_000n };
const clock = { t: Date.parse("2026-11-02T12:00:00Z") };
const g = VetoGuard.create({ policyText: JSON.stringify(doc), clock: () => clock.t, prices: PRICES });
for (let i=0;i<5;i++){
  const r = await g.submit({id:`m${i}`,kind:"ft.transfer",actor:"argo.near",asset:"NEAR",amount:"1.25",to:"compute.near"});
  console.log(i, r.decision.verdict, r.decision.evaluatedAt);
  clock.t += 10_000;
}
console.log("ledger:", JSON.stringify(g.snapshot().ledger.map(r=>({id:r.actionId, at:new Date(r.at).toISOString(), st:r.status}))));
clock.t += 86_400_000;
console.log("now:", new Date(clock.t).toISOString());
const d = g.preview({id:"m9",kind:"ft.transfer",actor:"argo.near",asset:"NEAR",amount:"1.25",to:"compute.near"});
console.log("preview", d.verdict, JSON.stringify(d.limits.daily), d.reasons.map(x=>x.code).join(","));
