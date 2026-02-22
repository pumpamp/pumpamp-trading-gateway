# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email **security@pumpamp.com** with details
3. Include steps to reproduce if possible

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Scope

This policy covers the PumpAmp Trading Gateway codebase. Issues related to exchange APIs (Kalshi, Polymarket, Hyperliquid, Binance) should be reported to those platforms directly.

## Credential Safety

The gateway is designed so that exchange credentials never leave your machine. If you find a code path where credentials could be leaked (via logs, relay messages, or network requests to non-exchange endpoints), that is a critical security issue -- please report it immediately.
