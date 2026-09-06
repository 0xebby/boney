# Prompts

Verbatim log of the prompts given in this repo, oldest first.

---

## 2026-09-06

```
add all md files to boneymd and update references
```

```
gitignore netlify.toml .gas-snapshot .indexer-state.json KPI_EVENT_SOURCING.html and back envs then
commit but i have to see the commit messages first and your comments should be less prosy ... from
now, store all my prompts in a rompts.md file
```

```
restore netlify.toml and delete the back envs and use just one-liner commit messages ... where's the
prompts.md?
```

```
commit messages is good, push
```

```
read  eth-global-2026-plan.md  as i have updated it and added decision leanings, don't update
anything , just share informed opinions here
```

```
check updated decisions and suggest an actual fix for this considering boney's complexities: "I'd drop
this one. CampaignRegistry.createCampaign uses new Campaign (src/campaign/CampaignRegistry.sol:73) —
plain CREATE, nonce-dependent. So the addresses that actually matter, the ones in relay-loop.sh's
TARGETS and the frontend catalog, stay non-deterministic no matter what you do to the singletons.

The singletons also take chain-specific constructor args — CampaignRegistry takes four deployed
addresses, EscrowVault an admin, the verifier an owner and reporter. Identical addresses require
byte-identical args, which means the deploy order has to produce the same addresses, which is the thing
you were trying to get. Circular unless you switch everything to initializers behind proxies, which is a
much larger change than §0's budget."
```

```
[1:54 am, 06/09/2026] ebby: Plan out a different flow for both contracts and frontend that allows
creations of campaigns with updated logics without adding those campaigns to boney actual registry,
allowing me to test with creation of new contracts, filter topics, etc

Also allows deletion of campaigns

Set localhost 3002 as dedicated server for this new front

Load up all skiils from your skills.md that I made
[2:17 am, 06/09/2026] ebby: I need subgraph more involved since it's faster and more reliable than even
a relayer, maybe as a third eye to all other verifiers and have a say in what's finally reported
instead of just enumerating for frontend and boneyboard etc
```

```
// Reject a gate no wallet could clear.
        uint256 reputationCap = type(uint256).max;
        try IReputationRegistry(reputationRegistry_).maxScore() returns (uint256 reported) {
            reputationCap = reported;
        } catch {}
        if (cfg.minReputation > reputationCap) revert UnreachableReputation(cfg.minReputation, reputationCap); shouldn't this be checking against boneyscore?
```

```
add prompts.md to tracked file, commit and push only after i approve the commit messages, commit and
push the eth global plan too
```

```
push
```
