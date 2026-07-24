// SPDX-License-Identifier: MIT
//
// Bare-minimum ERC-721 used by `e2e/send-nft-anvil.spec.ts`.
//
// Compiled at test-fixture load time via `compile-erc721.ts` (uses
// solc-js, no native deps). This contract intentionally covers ONLY
// the surface the wallet exercises — no events, no approval flow,
// no transfer hooks. End-to-end NFT-send testing wants:
//
//   detectNftStandard → supportsInterface(0x80ac58cd)
//   addNft owner check → ownerOf(tokenId)
//   safeTransferFrom from sign-confirm → state mutation visible to
//                                        a subsequent ownerOf call
//
// Anyone extending this contract should keep it small enough that
// solc-js compile time stays under ~1 s per test run.

pragma solidity ^0.8.0;

contract MinimalErc721 {
    mapping(uint256 => address) private _owners;
    string private _tokenURI;

    // Canonical ERC-721 Transfer event. The wallet's auto-discovery
    // (no-Enumerable fallback) scans these logs to find owned
    // tokenIds, so emitting on every state-changing op is what
    // makes that code path testable end-to-end.
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    // Constructor takes the metadata URI to be returned by
    // tokenURI() for every minted id. All tokens share the same
    // metadata — keeps the contract minimal (no string concat /
    // toString helper bloat) and matches how a lot of "PFP"
    // collections actually work in practice (one base URI →
    // wallet's UX shows the collection's image for each token).
    // Empty string is allowed — wallet falls back to "<symbol> #<id>"
    // and shows the 🖼 placeholder card art.
    constructor(string memory tokenURI_) {
        _tokenURI = tokenURI_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // 0x80ac58cd = ERC-721; 0x01ffc9a7 = ERC-165 itself.
        return interfaceId == 0x80ac58cd || interfaceId == 0x01ffc9a7;
    }

    function tokenURI(uint256 /* tokenId */) external view returns (string memory) {
        return _tokenURI;
    }

    function mint(address to, uint256 tokenId) external {
        require(_owners[tokenId] == address(0), "already minted");
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "not minted");
        return owner;
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(_owners[tokenId] == from, "wrong owner");
        require(msg.sender == from, "caller is not owner");
        require(to != address(0), "zero recipient");
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function name() external pure returns (string memory) { return "Test"; }
    function symbol() external pure returns (string memory) { return "TEST"; }
}
