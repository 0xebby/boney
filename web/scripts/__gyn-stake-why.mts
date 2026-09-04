import {createPublicClient, http, getAddress, parseUnits, parseAbiItem, type PublicClient} from "viem";
import {baseSepolia} from "viem/chains";
const client = createPublicClient({chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com", {retryCount: 5})}) as PublicClient;
const STAKING = getAddress("0x5c0E023Ce4A353e5Cd9a43E28D2879Cb9e876865");
const GYND = getAddress("0x0d442EC7BdDB06b531DCA3Dd39ABaFf554170776");
const ABI = [parseAbiItem("function stake(address token, uint256 amount)")];
try {
  await client.simulateContract({address: STAKING, abi: ABI, functionName: "stake", args: [GYND, parseUnits("1", 18)], account: getAddress("0x5Ae96df858Ed87F98a34b177Bd306c829316E727")});
} catch (e) { console.log((e as Error).message.split("\n").slice(0, 8).join("\n")); }
// Same call, with the allowance overridden so only the amount rule can fail.
const {encodeFunctionData} = await import("viem");
for (const amt of ["0.0001", "1", "10", "100"]) {
  try {
    await client.call({
      account: getAddress("0x5Ae96df858Ed87F98a34b177Bd306c829316E727"),
      to: STAKING,
      data: encodeFunctionData({abi: ABI, functionName: "stake", args: [GYND, parseUnits(amt, 18)]}),
      stateOverride: [{address: GYND, stateDiff: []}],
    });
    console.log(`${amt} GYND: ok (no allowance override needed?)`);
  } catch (e) { console.log(`${amt} GYND: ${(e as Error).message.split("\n").find((l) => /reverted|reason|Error/i.test(l)) ?? "revert"}`); }
}
