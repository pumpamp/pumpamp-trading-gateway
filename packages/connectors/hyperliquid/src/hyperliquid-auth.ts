import { ethers } from 'ethers';
import type { HyperliquidSignature } from './types.js';

// ============================================================
// EIP-712 signing for Hyperliquid exchange actions
// ============================================================

const HYPERLIQUID_CHAIN_ID = 42161; // Arbitrum mainnet
const DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: HYPERLIQUID_CHAIN_ID,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

const ACTION_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

/**
 * Sign a Hyperliquid exchange action using EIP-712
 * @param wallet - ethers.js Wallet instance
 * @param action - The action object to sign
 * @param nonce - Current timestamp in milliseconds
 * @param vaultAddress - Optional vault address for vault trading
 * @returns EIP-712 signature components
 */
export async function signAction(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  action: object,
  nonce: number,
  vaultAddress?: string
): Promise<HyperliquidSignature> {
  const actionHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(action))
  );

  const message = {
    source: vaultAddress ?? wallet.address,
    connectionId: actionHash,
  };

  const signature = await wallet.signTypedData(DOMAIN, ACTION_TYPES, message);
  const sig = ethers.Signature.from(signature);

  return {
    r: sig.r,
    s: sig.s,
    v: sig.v,
  };
}

/**
 * Create a phantom agent for signing (required by Hyperliquid)
 * Returns a minimal signature payload for authentication
 */
export function createPhantomAgent(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  isMainnet: boolean
): { source: string; connectionId: ethers.BytesLike } {
  return {
    source: isMainnet ? 'mainnet' : 'testnet',
    connectionId: ethers.zeroPadValue(wallet.address, 32),
  };
}
