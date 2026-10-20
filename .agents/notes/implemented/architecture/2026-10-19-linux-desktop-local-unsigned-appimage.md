# Agent Note: Linux desktop builds are local unsigned AppImages

Status: implemented

English | [中文](2026-10-19-linux-desktop-local-unsigned-appimage.zh.md)

## Problem

Desktop packaged only macOS and Windows, and the account provider accepted only `darwin` and `win32` as a native desktop identity. The shared primary runtime already declared `linux-x64`; the sandbox, terminal, and subprocess layers already selected Linux providers; and LibreOffice already fell back to its WASM engine on Linux. The missing pieces were the Desktop target table, the Electron executable and launcher layouts, and a truthful Platform client identity for Host API and embedded Platform requests.

## Decision

Desktop adds a `linux-x64` package target that builds on a Linux x64 host and always emits an unsigned AppImage. `pnpm run dev:desktop` and `pnpm run start:desktop` prepare the Linux runtime and launch the shell. The target has no release signing, automatic update feed, mandatory-update policy, publication or upload path, CI packaging workflow, system tray, or `dsh` command installation. `--build-version auto` is rejected because the version discovery and update feeds remain limited to macOS and Windows.

The native Desktop client identity becomes `DesktopClientPlatform = 'darwin' | 'win32' | 'linux'`, mapped to `desktop-mac`, `desktop-win`, and `desktop-linux`. The base bundle supplies the value to the Desktop profile, and the embedded Platform view derives the same value from `process.platform`. A profile patch replaces an entry's config wholesale, so a user patch that configures `deepseek-account` must restate `desktopPlatform`; the built-Host welcome fixture does.

Linux packages disable ASAR, so the bundled runtime and its native executables keep real filesystem paths. ASAR's `lstatSync(..., { throwIfNoEntry: false })` returns `null` for a missing path where Node returns `undefined`, which made the LibreOffice kit treat its absent native engine as an incomplete installation instead of falling back to WASM. The real layout also lets `child_process` execute the Landlock launcher directly; the sandbox's `.asar` to `.asar.unpacked` rewrite remains for the ASAR-based macOS and Windows packages.

Closing the main window on Linux goes through the ordinary quit confirmation instead of hiding the window, because Linux provides neither a tray nor a Dock icon to reopen a hidden window.

## Alternatives considered

**Report `desktop-mac` on Linux.** This preserves the existing Platform header set without a backend change, but it misreports the operating system in Platform analytics and feature decisions.

**Keep Linux unsupported.** The runtime and native packages already support Linux, and the user need was a local desktop build with account sign-in; leaving the target unsupported would withhold working capability for an artificial release-policy reason.

**Add full release parity.** Linux signing, update hosting, mandatory policy, publishing, and CI packaging would require a Linux signing and distribution design that does not exist. The local unsigned build exercises the same runtime, Host, and login paths without claiming release qualification.

## Consequences

`pnpm run package:desktop:linux:x64` produces an unsigned AppImage under `targets/linux-x64/unsigned-artifacts/`; `package:desktop:linux:x64:dir` stops at `linux-unpacked/`. Office conversion uses the WASM engine, so the payload is larger and slower than the native macOS and Windows engines. Restricted hosts may need Chromium's `--no-sandbox` or an unprivileged user-namespace policy, and AppImage execution needs FUSE 2 or `--appimage-extract-and-run`. The Platform backend must accept or ignore `desktop-linux`; the login protocol itself does not validate the header locally. The built-Host welcome e2e and the focused packaging tests cover the Linux header, target selection, launcher layout, and Landlock path rewrite.
