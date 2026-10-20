# Agent Note：Linux 桌面构建是本地未签名 AppImage

Status: implemented

[English](2026-10-19-linux-desktop-local-unsigned-appimage.md) | 中文

## Problem

Desktop 之前只打包 macOS 和 Windows，账号 provider 也只接受 `darwin` 和 `win32` 作为原生桌面身份。共享 primary runtime 已声明 `linux-x64`；sandbox、terminal 和 subprocess 层已有 Linux provider；LibreOffice 在 Linux 上已回退到 WASM 引擎。缺失的是 Desktop 目标表、Electron 可执行文件与启动器布局，以及 Host API 和内嵌 Platform 请求所需的 Platform 客户端身份。

## Decision

Desktop 增加 `linux-x64` 打包目标：在 Linux x64 主机上构建，并且始终产出未签名 AppImage。`pnpm run dev:desktop` 和 `pnpm run start:desktop` 会准备 Linux 运行时并启动壳。该目标不提供发布签名、自动更新源、强制更新策略、发布或上传路径、CI 打包 workflow、系统托盘或 `dsh` 命令安装。`--build-version auto` 被拒绝，因为版本发现和更新源仍只覆盖 macOS 与 Windows。

原生 Desktop 组合新增 `DesktopClientPlatform = 'darwin' | 'win32' | 'linux'`；Linux 在请求头中按 [Linux Platform 客户端身份说明](2026-10-20-linux-desktop-platform-client-identity.zh.md) 记录的原因报告 `desktop-mac`。base bundle 为 Desktop profile 提供该值，内嵌 Platform 视图从 `process.platform` 推导同一个值。profile patch 会整体替换条目的 config，因此配置 `deepseek-account` 的用户 patch 必须重新声明 `desktopPlatform`；built-Host 欢迎流程 fixture 已这样做。

Linux 包关闭 ASAR，使内置运行时及其原生可执行文件保持真实文件系统路径。ASAR 的 `lstatSync(..., { throwIfNoEntry: false })` 对不存在的路径返回 `null`，而 Node 返回 `undefined`，这会让 LibreOffice kit 把缺失的原生引擎当成安装不完整，而不是回退到 WASM。真实布局也让 `child_process` 可以直接执行 Landlock 启动器；基于 ASAR 的 macOS 和 Windows 包仍保留 sandbox 的 `.asar` 到 `.asar.unpacked` 重写。

Linux 上关闭主窗口会进入普通退出确认，而不是隐藏窗口，因为 Linux 没有托盘或 Dock 图标来重新打开隐藏的窗口。

## Alternatives considered

**在 Linux 上报告 `desktop-mac`。** 这样可以不改 Platform 后端就沿用现有请求头集合，但会在 Platform 统计和功能判断中错误报告操作系统。Platform 的 `auth_exchange` 枚举拒绝 `desktop-linux` 后，[Linux Platform 客户端身份说明](2026-10-20-linux-desktop-platform-client-identity.zh.md) 采纳了该方案。

**继续不支持 Linux。** 运行时和原生包已经支持 Linux，用户需要的是可登录账号的本地桌面构建；以发布策略为由不提供可用能力没有必要。

**补齐完整发布链路。** Linux 签名、更新托管、强制策略、发布和 CI 打包需要一套尚不存在的 Linux 签名与分发设计。本地未签名构建已经覆盖相同的运行时、Host 和登录路径，且不声称具备发布资格。

## Consequences

`pnpm run package:desktop:linux:x64` 在 `targets/linux-x64/unsigned-artifacts/` 下产出未签名 AppImage；`package:desktop:linux:x64:dir` 停在 `linux-unpacked/`。Office 转换使用 WASM 引擎，因此载荷比 macOS 和 Windows 的原生引擎更大、更慢。受限主机可能需要 Chromium 的 `--no-sandbox` 或放开非特权用户命名空间策略，AppImage 运行需要 FUSE 2 或 `--appimage-extract-and-run`。Platform 的 `auth_exchange` 请求头枚举没有 Linux 值，因此 Linux 报告 `desktop-mac`（[说明](2026-10-20-linux-desktop-platform-client-identity.zh.md)）。built-Host 欢迎流程 e2e 与聚焦打包测试覆盖 Linux 请求头、目标选择、启动器布局和 Landlock 路径重写。
