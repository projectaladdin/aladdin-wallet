// SPDX-License-Identifier: MIT
//
// Bare-minimum ERC-20 used by the test-dapp's ERC-20 multi-scenario
// panel. Constructor takes name / symbol / decimals so each fresh
// deploy gets distinct identity; mint() is callable by anyone for
// test convenience (deliberately permissionless — the prod wallet
// doesn't broadcast mint() through any blessed flow).
//
// Surface kept narrow on purpose:
//   wallet.addToken            → name() / symbol() / decimals()
//   wallet.read-token-balances → balanceOf(addr)
//   Send screen (eth_sendTransaction) → transfer() + transferFrom()
//   approve preset             → approve() + allowance()
//   watchAsset                 → name / symbol / decimals only
//
// Anyone extending this should keep solc-js compile time under ~1 s
// (the dapp's /compile/erc20 endpoint synchronously compiles on
// demand; no caching beyond a single per-process memo).
pragma solidity ^0.8.0;

contract MinimalErc20 {
    string private _name;
    string private _symbol;
    uint8 private _decimals;
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function name()     external view returns (string memory) { return _name;     }
    function symbol()   external view returns (string memory) { return _symbol;   }
    function decimals() external view returns (uint8)         { return _decimals; }
    function totalSupply() external view returns (uint256)    { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }
    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function mint(address to, uint256 amount) external {
        require(to != address(0), "zero recipient");
        _totalSupply += amount;
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        // Skip the spend-allowance write when allowance is max-uint;
        // matches OZ behavior and saves a SSTORE on the typical infinite-
        // approval path.
        if (allowed != type(uint256).max) {
            _allowances[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(to != address(0), "zero recipient");
        uint256 fromBal = _balances[from];
        require(fromBal >= amount, "insufficient balance");
        unchecked { _balances[from] = fromBal - amount; }
        _balances[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
