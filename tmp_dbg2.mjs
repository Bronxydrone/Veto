import { SpendLedger, utcDayKey } from "./src/core/ledger.ts";
const day1 = Date.parse("2026-11-02T12:00:00Z");
const day2 = Date.parse("2026-11-03T12:00:00Z");
const rec = { actionId:"a", kind:"ft.transfer", asset:"NEAR", amountMinor:"1250000000000000000000000", amount:"1.25", to:"compute.near", at: day1, status:"committed", verdict:"allow" };
const l = new SpendLedger([rec], day1);
console.log("keys", utcDayKey(day1), utcDayKey(day2));
console.log("day1 spent", l.spent("NEAR","day").toString());
const l2 = l.withClock(day2);
console.log("day2 spent", l2.spent("NEAR","day").toString(), "now", new Date(l2.now).toISOString());
