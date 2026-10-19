import { derivedPublicKey } from "./src/chain/chainsig.ts";
for (const net of ["mainnet","testnet"]) {
  const k = await derivedPublicKey({ account: "argo.near", path: "ethereum-1", network: net });
  console.log(net, k.evmAddress, k.publicKey.slice(0, 24) + "...");
}
