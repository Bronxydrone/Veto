const call = async (rpc, account, args) => {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: "1", method: "query", params: {
      request_type: "call_function", finality: "final", account_id: account,
      method_name: "derived_public_key", args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) });
  const json = await res.json();
  const out = json.result?.result;
  return out ? Buffer.from(out).toString("utf8") : JSON.stringify(json.error ?? json).slice(0, 300);
};
console.log("testnet:", await call("https://rpc.testnet.near.org", "v1.signer-prod.testnet", { path: "ethereum-1", predecessor: "argo.testnet", key_version: 0 }));
console.log("mainnet:", await call("https://free.rpc.fastnear.com", "v1.signer", { path: "ethereum-1", predecessor: "argo.near", key_version: 0 }));
