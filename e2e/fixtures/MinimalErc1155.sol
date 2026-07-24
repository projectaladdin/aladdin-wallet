// SPDX-License-Identifier: MIT
//
// Minimal ERC-1155 used by `e2e/send-nft-anvil.spec.ts` (1155 path)
// + the dapp's manual deploy button. Same scope decision as
// MinimalErc721.sol: only the surface the wallet exercises, no
// approval flow, no royalty, no extension interfaces.
//
// Wallet calls covered:
//   detectNftStandard      → supportsInterface(0xd9b67a26)
//   verifyNftOwnership     → balanceOf(account, id)
//   safeTransferFrom       → state mutation visible to balanceOf
//   fetchNftMeta           → uri(id) (returns empty here; meta fetch
//                            gracefully falls back to "<symbol> #<id>")
//
// Mint API is `mint(to, id, amount)` — semi-fungible, can mint > 1
// of the same id to one owner (vs. ERC-721 where each id is unique).

pragma solidity ^0.8.0;

contract MinimalErc1155 {
    // id => owner => balance
    mapping(uint256 => mapping(address => uint256)) private _balances;
    string private _uri;

    // Constructor takes the metadata URI for `uri()`. Same design
    // decision as MinimalErc721: one URI for all tokenIds, set at
    // deploy time. Real ERC-1155 implementations substitute `{id}`
    // — left out here for simplicity.
    constructor(string memory uri_) {
        _uri = uri_;
    }

    // ERC-1155 canonical events. The auto-discovery event-scan path
    // currently only listens for TransferSingle (TransferBatch is rare
    // for owner-receive flows); both emit on mint.
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );
    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] values
    );

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // 0xd9b67a26 = ERC-1155; 0x01ffc9a7 = ERC-165 itself.
        return interfaceId == 0xd9b67a26 || interfaceId == 0x01ffc9a7;
    }

    function mint(address to, uint256 id, uint256 amount) external {
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata /* data */
    ) external {
        require(msg.sender == from, "caller is not owner");
        require(_balances[id][from] >= amount, "insufficient balance");
        require(to != address(0), "zero recipient");
        _balances[id][from] -= amount;
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    function uri(uint256 /* id */) external view returns (string memory) {
        return _uri;
    }
}
