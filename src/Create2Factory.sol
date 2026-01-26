// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @notice Minimal CREATE2 factory with the same deploy() signature as the widely-used singleton factory pattern:
///         deploy(bytes initCode, bytes32 salt) -> address
/// This makes it easy to (optionally) point the CLI at a predeployed singleton factory address on chains that have one.
contract Create2Factory {
    event Deployed(address indexed addr, bytes32 indexed salt);

    /// @dev Deploys a contract using CREATE2 with `initCode` and `salt`.
    /// `msg.value` is forwarded to the new contract's constructor.
    function deploy(bytes memory initCode, bytes32 salt) public payable returns (address addr) {
        require(initCode.length != 0, "Create2Factory: empty initCode");

        assembly {
            addr := create2(callvalue(), add(initCode, 0x20), mload(initCode), salt)
        }

        require(addr != address(0), "Create2Factory: create2 failed");
        require(addr.code.length != 0, "Create2Factory: no code");

        emit Deployed(addr, salt);
    }
}

