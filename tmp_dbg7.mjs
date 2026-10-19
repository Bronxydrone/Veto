import { readFileSync } from "node:fs";
import { VetoGuard } from "./src/core/service.ts";
import { PRICES, START } from "./src/demo/scenarios.ts";
const clock = { t: START - 2*86_400_000 };
const g = VetoGuard.create({ policyText: readFileSync("examples/policy.yaml","utf8"), clock: () => clock.t, prices: PRICES });
const w = await g.submit({id:"w1",kind:"ft.transfer",actor:"argo.near",asset:"USDC",amount:"3",to:"compute.near"});
console.log("warm", w.decision.verdict, w.decision.reasons.map(r=>r.code).join(","));
if (w.approval) console.log("approve warm:", (await g.approve(w.approval.id, "alice.near")).status);
clock.t = START;
const a = await g.submit({id:"a1",kind:"ft.transfer",actor:"argo.near",asset:"USDC",amount:"5",to:"compute.near"});
console.log("a1", a.decision.verdict, a.decision.reasons.map(r=>r.code).join(","));
clock.t += 7000;
const b = await g.submit({id:"a2",kind:"ft.transfer",actor:"argo.near",asset:"USDC",amount:"12",to:"api.data-market.near"});
console.log("a2", b.decision.verdict, b.decision.reasons.map(r=>r.code).join(","), b.decision.limits.daily && JSON.stringify(b.decision.limits.daily));
clock.t += 7000;
const c = await g.submit({id:"a3",kind:"ft.transfer",actor:"argo.near",asset:"USDC",amount:"20",to:"compute.near"});
console.log("a3", c.decision.verdict, c.decision.reasons.map(r=>r.code).join(","));
if (c.approval) { const r = await g.approve(c.approval.id, "alice.near"); console.log("approve a3:", r.status, r.decision?.reasons.map(x=>x.code).join(","), JSON.stringify(r.decision?.limits.daily)); }
