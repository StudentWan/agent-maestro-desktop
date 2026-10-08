# Desktop platform checks

CI runs the test suite and TypeScript checks on Linux, Windows x64, macOS Intel, and macOS Apple Silicon. Windows and macOS jobs also build distributables, decode the packaged runtime icon, create a native tray/menu, and verify the packaged CommonJS entry point. macOS tests compile the window-detection script with `osacompile`.

CI does not grant macOS Automation/Accessibility permissions or use a Copilot account. Before release, run these interactive checks on both Mac architectures:

1. Extract the matching ZIP and move the app into Applications. Launch it from Finder. Confirm the Dock icon, menu bar icon, and main window appear.
2. Confirm ⌘C/⌘V work in text fields, closing the window leaves the proxy running, and clicking the Dock icon reopens a hidden or minimized window. Quit with ⌘Q and check that the proxy port is released.
3. With `gh` installed through Homebrew, check that the Codespaces panel detects it after a Finder launch. Log in and verify a local Claude/Codex request reaches the proxy.
4. Open a Codespace in VS Code. Grant the requested Automation/Accessibility access and confirm automatic detection and connection. Check VS Code Insiders if installed. Deny access in a separate run and confirm manual Codespaces connections still work.
5. Enable launch at login, quit, and sign out/in. Confirm the app starts once. Disable the setting and repeat to confirm it stays off.

On Windows, install the generated EXE and check Desktop/Start Menu shortcuts, launching a second instance, close-to-tray, Show/Quit, launch at login, and automatic VS Code Codespaces detection. Existing Squirrel install/update handling and PowerShell enumeration use their original Windows paths.
