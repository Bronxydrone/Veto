import { readFileSync } from "node:fs";
import { loadPolicy } from "./src/core/policy.ts";
import { VetoGuard } from "./src/core/service.ts";
const text = readFileSync("examples/policy.yaml","utf8");
const doc = structuredClone(loadPolicy(text).doc); doc.risk = {};
const LAB = JSON.stringify(doc);
const PRICES = { NEAR: 2_450_000n, USDC: 1_000_000n };
const clock = { t: Date.parse("2026-11-02T12:00:00Z") };
const g = VetoGuard.create({ policyText: LAB, clock: () => clock.t, prices: PRICES });
for (let i=0;i<5;i++){ const r = await g.submit({id:`m${i}`,kind:"ft.transfer",actor:"argo.near",asset:"NEAR",amount:"1.25",to:"compute.near"}); console.log(i, r.decision.verdict, r.decision.reasons.map(x=>x.code).join(",")); clock.t += 10_000; }
console.log("--- jump a day");
clock.t += 86_400_000;
const r = await g.submit({id:"m9",kind:"ft.transfer",actor:"argo.near",asset:"NEAR",amount:"1.25",to:"compute.near"});
console.log("day2", r.decision.verdict, r.decision.reasons.map(x=>x.code).join(","), JSON.stringify(r.decision.limits.daily));
console.log("--- toctou");
const doc2 = structuredClone(loadPolicy(text).doc); doc2.risk={}; doc2.velocity={}; doc2.limits.perTx = { ...doc2.limits.perTx, USDC: 100 };
const clock2 = { t: Date.parse("2026-11-02T12:00:00Z") };
const g2 = VetoGuard.create({ policyText: JSON.stringify(doc2), clock: ()=>clock2.t, prices: PRICES });
for (const [id, amt] of [["b","60"],["o","30"],["s1","10"]]) {
  const r2 = await g2.submit({id,kind:"ft.transfer",actor:"argo.near",asset:"USDC",amount:amt,to:"compute.near"});
  console.log(id, amt, r2.decision.verdict, r2.decision.reasons.map(x=>x.code).join(","), JSON.stringify(r2.decision.limits.daily));
}
