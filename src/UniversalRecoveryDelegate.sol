// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { EIP712 } from "../lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "../lib/openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @notice Execution logic intended to be used via EIP-7702 delegation.
 * @dev When called via the delegated EOA, `address(this)` refers to the EOA.
 *      This contract is deployed once per chain and used as the delegation target.
 */
contract UniversalRecoveryDelegate is EIP712 {
    error CallFailed(uint256 index, address to, uint256 value, bytes data, bytes reason);
    error IntentExpired(uint256 deadline, uint256 nowTs);
    error InvalidNonce(address signer, uint256 expected, uint256 provided);
    error InvalidSignature();

    /**
     * @notice Legacy configuration field (not used for authorization).
     * @dev Execution is authorized by an EIP-712 signature from `authorizer` plus a consumed nonce.
     * Anyone may submit the transaction (ERC-7702); copied calldata must fail outside this delegated account context.
     */
    address public immutable PAYMASTER;

    /**
     * @dev Unstructured storage to avoid collisions inside a delegated EOA.
     */
    bytes32 private constant _STORAGE_SLOT =
        bytes32(uint256(keccak256("hwr.universalRecoveryDelegate.storage.v1")) - 1);

    struct DelegateStorage {
        mapping(address => uint256) nonces;
    }

    function _ds() private pure returns (DelegateStorage storage s) {
        bytes32 slot = _STORAGE_SLOT;
        assembly ("memory-safe") {
            s.slot := slot
        }
    }

    /// @notice Per-authorizer nonce for EIP-712 intents.
    function nonces(address authorizer) external view returns (uint256) {
        return _ds().nonces[authorizer];
    }

    constructor(address _paymaster) EIP712("UniversalRecoveryDelegate", "1") {
        // EIP-712 domain separator binds intents to:
        // - chainId (prevents cross-chain replay)
        // - verifyingContract = address(this) (under EIP-7702: the delegated EOA address, not the implementation)
        require(_paymaster != address(0), "paymaster=0");
        PAYMASTER = _paymaster;
    }

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    // ---- EIP-712 intent verification ----

    // keccak256("Call(address to,uint256 value,bytes data)")
    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");

    // keccak256("RecoveryIntent(address recoveryAddress,bytes32 callsHash,uint256 nonce,uint256 deadline)")
    bytes32 private constant RECOVERY_INTENT_TYPEHASH =
        keccak256("RecoveryIntent(address recoveryAddress,bytes32 callsHash,uint256 nonce,uint256 deadline)");

    /**
     * @notice Computes the EIP-712 digest for a recovery intent.
     * @dev `callsHash` commits to the full batch (targets, values, and calldata bytes).
     */
    function recoveryIntentDigest(
        address recoveryAddress,
        Call[] calldata calls,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32 digest, bytes32 callsHash) {
        callsHash = _hashCalls(calls);
        bytes32 structHash;
        bytes32 typehash = RECOVERY_INTENT_TYPEHASH;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, typehash)
            mstore(add(ptr, 0x20), recoveryAddress)
            mstore(add(ptr, 0x40), callsHash)
            mstore(add(ptr, 0x60), nonce)
            mstore(add(ptr, 0x80), deadline)
            structHash := keccak256(ptr, 0xa0)
        }
        digest = _hashTypedDataV4(structHash);
    }

    function _hashCalls(Call[] calldata calls) internal pure returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            callHashes[i] = keccak256(
                abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data))
            );
        }
        return _hashBytes32Array(callHashes);
    }

    /// @dev Equivalent to `keccak256(abi.encode(values))` for a single `bytes32[] memory` argument.
    function _hashBytes32Array(bytes32[] memory values) private pure returns (bytes32 out) {
        assembly ("memory-safe") {
            let len := mload(values)

            // abi.encode(values) for a single dynamic argument is:
            // 0x00: offset to data (0x20)
            // 0x20: length (len)
            // 0x40: elements (len * 32 bytes)
            let ptr := mload(0x40)
            mstore(ptr, 0x20)
            mstore(add(ptr, 0x20), len)

            let src := add(values, 0x20)
            let dst := add(ptr, 0x40)
            let bytesLen := mul(len, 0x20)

            for { let i := 0 } lt(i, bytesLen) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }

            out := keccak256(ptr, add(0x40, bytesLen))
            mstore(0x40, add(ptr, add(0x40, bytesLen)))
        }
    }

    /**
     * @notice Executes a batch of calls.
     * @dev Anyone may submit; authorization is via EIP-712 signature + nonce.
     * @dev Reverts on first failure and bubbles the raw revert data via `CallFailed`.
     * @dev Finally, it sweeps any remaining funds to the recovery address at the end.
     */
    function executeBatchRecovery(
        address _recoveryAddress,
        Call[] calldata calls,
        address authorizer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        if (authorizer == address(0)) revert InvalidSignature();
        if (deadline != 0 && block.timestamp > deadline) revert IntentExpired(deadline, block.timestamp);

        (bytes32 digest,) = recoveryIntentDigest(_recoveryAddress, calls, nonce, deadline);

        // IMPORTANT: Do not just "recover some address" from the signature.
        // Any (hash, signature) pair always recovers to *some* address, which would make
        // cross-context copied calldata potentially executable under a different recovered signer.
        if (!SignatureChecker.isValidSignatureNowCalldata(authorizer, digest, signature)) revert InvalidSignature();

        DelegateStorage storage s = _ds();
        uint256 expected = s.nonces[authorizer];
        if (nonce != expected) revert InvalidNonce(authorizer, expected, nonce);
        s.nonces[authorizer] = expected + 1;

        // Execute all calls.
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory reason) = calls[i].to.call{ value: calls[i].value }(calls[i].data);
            if (!ok) revert CallFailed(i, calls[i].to, calls[i].value, calls[i].data, reason);
        }

        // Sweep any remaining funds to the recovery address at the end.
        if (address(this).balance > 0) {
            (bool ok, bytes memory reason) = payable(_recoveryAddress).call{ value: address(this).balance }("");
            if (!ok) revert CallFailed(calls.length, _recoveryAddress, address(this).balance, "", reason);
        }
    }

    receive() external payable {
    }
}

