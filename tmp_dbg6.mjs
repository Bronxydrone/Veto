import { readFileSync } from "node:fs";
import { loadPolicy } from "./src/core/policy.ts";
import { VetoGuard } from "./src/core/service.ts";
const doc = structuredClone(loadPolicy(readFileSync("examples/policy.yaml","utf8")).doc); doc.risk = {};
const clock = { t: Date.parse("2026-11-02T12:00:00Z") };
const g = VetoGuard.create({ policyText: JSON.stringify(doc), clock: () => clock.t, prices: { NEAR: 2_450_000n } });
for (let i=0;i<4;i++){ await g.submit({id:`x${i}`,kind:"ft.transfer",actor:"argo.near",asset:"NEAR",amount:"1.25",to:"compute.near"}); clock.t += 10_000; }
clock.t += 86_400_000;
const d = g.preview({id:"z",kind:"ft.transfer",actor:"argo.near",asset:"NEAR",amount:"1.25",to:"compute.near"});
console.log("preview evaluatedAt", d.evaluatedAt, d.verdict);
console.log("checks:", d.checks.filter(c=>c.id.includes("budget")).map(c=>`${c.id}:${c.passed}:${c.detail}`).join(" | "));
