# Agent Note：Linux 桌面用 macOS 的 Platform 客户端身份登录

Status: implemented

[English](2026-10-20-linux-desktop-platform-client-identity.md) | 中文

## Problem

Linux 桌面构建能打开 Platform 的浏览器授权页，但 Host 无法换取返回的授权码：Platform 的 `/auth-api/v0/dsh/auth_exchange` 对 `x-client-platform: desktop-linux` 返回 HTTP 422，并指向 `header.x-client-platform`。`auth_init` 接受同一个值，因此浏览器步骤成功，只有最后的换取失败，Desktop 将其显示为登录失败。对线上端点的探测显示：请求头为 `web`、`desktop-mac` 或 `desktop-win` 时返回带 `INVALID_CODE` 的正常响应信封（针对探测用的授权码），为 `desktop-linux` 时返回 422 拒绝。

## Decision

`DesktopClientPlatform` 继续以 `darwin`、`win32` 和 `linux` 作为组合值，Desktop 仍从 `process.platform` 推导该值。`desktopClientHeaders` 中的线上映射为 `linux` 发送 `desktop-mac`，使 Host 账号请求和内嵌 Platform 视图携带 `auth_exchange` 接受的客户端身份。没有请求会发送 `desktop-linux`，登录路径也不会重试被 Platform 拒绝的换取。

## Alternatives considered

**在 Linux 上发送 `web`。** `auth_exchange` 接受 `web`，也不会谎报操作系统，但会把桌面应用在 Platform 的客户端专属行为中识别为网页客户端。macOS 身份沿用 macOS 和 Windows 已经验证的桌面流程。

**在收到 422 后用 `web` 重试 `auth_exchange`。** 这样在后台接受 `desktop-linux` 时保留正确身份，只在不接受时降级；但它会对同一个授权码换取两次，并给登录路径加入隐藏回退。被拒绝的客户端身份是固定的协议不一致，不是瞬时请求失败。

**保持 `desktop-linux`，等待 Platform 支持。** 登录协议本身是正确的，但在 Platform 增加该枚举值前 Linux 用户无法登录，而本地构建的目的正是提供该能力。

## Consequences

Platform 会把 Linux Desktop 会话、Host API 请求和内嵌 Platform 视图记录为 macOS，因此其统计和客户端专属判断无法区分 Linux。只有 Platform 的 `auth_exchange` 枚举接受 Linux 值后，真实操作系统才会回到请求头；该变更修改 `packages/credentials/deepseek-account/src/index.ts` 中的映射。[Linux Desktop 打包说明](2026-10-19-linux-desktop-local-unsigned-appimage.zh.md) 保留 Linux Desktop 的其余决策。

## Testing

`packages/credentials/deepseek-account/tests/client-headers.spec.ts` 和 `packages/credentials/deepseek-account-platform/tests/account.spec.ts` 固定 Linux 的线上值。`apps/desktop/tests/platform-view.spec.ts` 覆盖内嵌 Platform 视图，`apps/desktop/tests/welcome-flow.e2e.ts` 覆盖 built Host 的登录请求头和流程。
