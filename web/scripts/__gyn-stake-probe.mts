/** Inspects existing stake events and referral-wallet balances. */
import {
  createPublicClient,
  http,
  getAddress,
  formatEther,
  parseAbiItem,
  type GetLogsReturnType,
  type PublicClient,
} from "viem";
import {baseSepolia} from "viem/chains";

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
const client = createPublicClient({chain: baseSepolia, transport: http(RPC, {retryCount: 5})}) as PublicClient;

const STAKING = getAddress("0x5c0E023Ce4A353e5Cd9a43E28D2879Cb9e876865");
const STAKED_TOPIC = "0x9e71bc8eea02a63969f509818f2dafb9254532904319f9dbda79b67bd34a5f3d";

const head = await client.getBlockNumber();
console.log("head", head);

// Resolve the deployed `Staked` topic.
const {keccak256, toHex} = await import("viem");
const topic0 = keccak256(toHex("Staked(address,address,uint256)"));
console.log("topic0", topic0, "(hardcoded guess", STAKED_TOPIC, ")");

const stakedEvent = parseAbiItem(
  "event Staked(address indexed user, address indexed token, uint256 amount)",
);
let logs: GetLogsReturnType<typeof stakedEvent> = [];
for (let span = 0n; span < 5n && logs.length === 0; span++) {
  const to = head - span * 9000n;
  const from = to - 9000n;
  logs = await client.getLogs({
    address: STAKING,
    event: stakedEvent,
    fromBlock: from,
    toBlock: to,
  });
  console.log(`  scan ${from}-${to}: ${logs.length} Staked`);
}

for (const l of logs.slice(-4)) {
  const tx = await client.getTransaction({hash: l.transactionHash});
  console.log(`\nStaked user=${l.args.user} token=${l.args.token} amount=${formatEther(l.args.amount!)} block=${l.blockNumber}`);
  console.log(`  tx to=${tx.to} selector=${tx.input.slice(0, 10)} inputLen=${(tx.input.length - 10) / 2} bytes`);
  console.log(`  input=${tx.input}`);
}

const code = await client.getCode({address: STAKING});
console.log("\nstaking code bytes", (code!.length - 2) / 2);
const {toFunctionSelector} = await import("viem");
for (const sig of [
  "stake(address,uint256)", "stake(uint256)", "deposit(address,uint256)", "deposit(uint256)",
  "isStakeToken(address)", "stakedOf(address,address)", "balanceOf(address)", "unstake(address,uint256)",
  "getReward()", "claim()", "earned(address)", "totalStaked(address)", "minStake()", "lockPeriod()",
  "cooldown()", "stakeInfo(address,address)", "userStake(address,address)",
]) {
  const sel = toFunctionSelector(`function ${sig}`);
  console.log(`  ${sel} ${code!.includes(sel.slice(2)) ? "PRESENT" : "-      "} ${sig}`);
}
