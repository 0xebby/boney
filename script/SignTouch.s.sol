// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";

contract SignTouch is Script {
    uint64 internal constant TOUCH_DURATION = 30 days;

    function run() external {
        uint256 KOL1_REF2 = vm.envUint("KOL1_REF2");
        uint256 relayerPk = vm.envUint("PRIVATE_KEY");

        address user = vm.addr(KOL1_REF2);
        address relayer = vm.addr(relayerPk);

        address registry = vm.parseAddress(
            vm.prompt("AttributionRegistry address")
        );

        address campaign = vm.parseAddress(
            vm.prompt("Campaign address")
        );

        bytes32 promoterId = vm.parseBytes32(
            vm.prompt("Promoter ID (bytes32)")
        );

        uint64 signedAt = uint64(block.timestamp);
        uint64 expiresAt = signedAt + TOUCH_DURATION;

        IAttributionRegistry.Touch memory touch =
            IAttributionRegistry.Touch({
                campaign: campaign,
                promoterId: promoterId,
                signedAt: signedAt,
                expiresAt: expiresAt
            });

        IAttributionRegistry registryContract =
            IAttributionRegistry(registry);

        bytes32 structHash = keccak256(
            abi.encode(
                registryContract.TOUCH_TYPEHASH(),
                touch.campaign,
                touch.promoterId,
                touch.signedAt,
                touch.expiresAt
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                registryContract.DOMAIN_SEPARATOR(),
                structHash
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KOL1_REF2, digest);

        bytes memory signature = abi.encodePacked(r, s, v);

        console2.log("User:");
        console2.logAddress(user);

        console2.log("Relayer:");
        console2.logAddress(relayer);

        console2.log("Campaign:");
        console2.logAddress(campaign);

        console2.log("Promoter ID:");
        console2.logBytes32(promoterId);

        console2.log("signedAt:");
        console2.logUint(signedAt);

        console2.log("expiresAt:");
        console2.logUint(expiresAt);

        console2.log("Signature:");
        console2.logBytes(signature);

        console2.log("Digest:");
        console2.logBytes32(digest);

        string memory answer =
            vm.prompt("Submit touch to registry? (y/n)");

        if (
            keccak256(bytes(answer)) !=
            keccak256(bytes("y"))
        ) {
            return;
        }

        vm.startBroadcast(relayerPk);

        registryContract.storeTouch(
            user,
            touch,
            signature,
            relayer
        );

        vm.stopBroadcast();
        
        console2.log("Touch submitted successfully.");
    }
}