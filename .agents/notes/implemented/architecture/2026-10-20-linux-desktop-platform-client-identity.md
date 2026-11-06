# Agent Note: Linux Desktop signs in with the macOS Platform client identity

Status: implemented

English | [中文](2026-10-20-linux-desktop-platform-client-identity.zh.md)

## Problem

The Linux Desktop build reached Platform's browser authorization page, but the Host could not exchange the returned authorization code: Platform's `/auth-api/v0/dsh/auth_exchange` rejects `x-client-platform: desktop-linux` with HTTP 422 and points at `header.x-client-platform`. `auth_init` accepts the same value, so the browser step succeeded and only the final exchange failed, which the Desktop reported as an unsuccessful sign-in. Probes against the live endpoint returned the accepted response envelope with `INVALID_CODE` for a probe authorization code when the header was `web`, `desktop-mac`, or `desktop-win`, and the 422 rejection when it was `desktop-linux`.

## Decision

`DesktopClientPlatform` keeps `darwin`, `win32`, and `linux` as composition values, and the Desktop still derives the value from `process.platform`. The wire map in `desktopClientHeaders` sends `desktop-mac` for `linux`, so Host account requests and the embedded Platform view carry a client identity that `auth_exchange` accepts. No request sends `desktop-linux`, and the sign-in path does not retry an exchange that Platform rejected.

## Alternatives considered

**Send `web` on Linux.** `auth_exchange` accepts `web`, and it does not claim a false operating system, but it identifies the desktop app as a web client in Platform's client-specific behavior. The macOS identity keeps the desktop flow that macOS and Windows already exercise.

**Retry `auth_exchange` with `web` after a 422.** This preserves `desktop-linux` where the backend accepts it and degrades only where it does not, but it exchanges the same authorization code twice and adds a hidden fallback to the sign-in path; a rejected client identity is a fixed contract mismatch, not a transient request failure.

**Keep `desktop-linux` and wait for Platform.** The login protocol is correct as designed, but Linux users cannot sign in until Platform adds the enum value, and the local build exists to provide that capability.

## Consequences

Platform records Linux Desktop sessions, Host API requests, and embedded Platform views as macOS, so its statistics and client-specific decisions cannot distinguish Linux. The true operating system returns to the wire only after Platform's `auth_exchange` enum accepts a Linux value; that change updates the map in `packages/credentials/deepseek-account/src/index.ts`. The [Linux Desktop packaging note](2026-10-19-linux-desktop-local-unsigned-appimage.md) retains the rest of the Linux Desktop decision.

## Testing

`packages/credentials/deepseek-account/tests/client-headers.spec.ts` and `packages/credentials/deepseek-account-platform/tests/account.spec.ts` pin the Linux wire value. `apps/desktop/tests/platform-view.spec.ts` covers the embedded Platform view, and `apps/desktop/tests/welcome-flow.e2e.ts` covers the built Host's sign-in headers and flow.
