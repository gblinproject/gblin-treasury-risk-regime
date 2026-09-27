import { parseAbi } from "viem";

export const VAULT_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function isNavReliable() view returns (bool)",
]);

export const LENS_ABI = parseAbi([
  "function basketLength(address vault) view returns (uint256)",
  "function quoteBuy(address vault, uint256 ethValue) view returns (uint256 out, uint256 protocolFee, uint256 stabilityFee)",
  "function quoteSell(address vault, uint256 gblinAmount) view returns (uint256)",
  "function asset(address vault, uint256 i) view returns (address token, address oracle, bool isStable, bool delisted, uint256 baseWeight, uint256 dynamicWeight, bool shielded, bool abandoned)",
  "function configFees(address vault) view returns (uint256 protocolFee, uint256 stabilityFee, uint256 minDeposit, uint256 oracleAge, uint256 oracleAgeTrade, uint256 sellCooldown, uint256 basketCap)",
  "function lastDepositTime(address vault, address account) view returns (uint256)",
]);

export const ZAP_ABI = parseAbi([
  "function buyGBLINWithToken(address tokenIn, uint256 amountIn, uint256 minWethOut, uint256 minGblinOut, bytes venueData, address receiver) returns (uint256)",
  "function sellGBLINForEth(uint256 shares, uint256 minEthOut, bytes[] venueData, address receiver) returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

export const SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);
