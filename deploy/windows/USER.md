# Install Kitzur on Windows

Your administrator supplies a Windows ZIP, its trusted manifest SHA256, a profile,
the approved tokenizer (inside the ZIP or separately) and Node.js 22+ / a pinned OpenCode build.
Use the organisation's normal script policy. No administrator rights are needed for Kitzur itself.

1. Verify the ZIP SHA256 against the administrator's trusted value with
   `Get-FileHash .\kitzur-0.1.0-windows-deployment.zip -Algorithm SHA256`, then extract it with Explorer.
2. In the extracted `kitzur-0.1.0` directory run:

   ```powershell
   .\deploy\windows\Install-Kitzur.ps1 -ManifestSha256 '<admin supplied 64 digit hash>'
   # If the tokenizer is a separate approved artifact, add:
   # -Tokenizer 'C:\approved\tokenizer.json'
   # If the profile is separate, add -Profile 'C:\approved\profile.json'
   ```

   Setup verifies the bundle, Node, tokenizer bytes/exact counting, config and gateway route/TLS.
   It never asks for a key, downloads prerequisites or overwrites your config. If prerequisites fail,
   fix them with the administrator and rerun. A login shortcut starts Kitzur on future logins.
3. Start it now and check status:

   ```powershell
   $kitzur = "$env:LOCALAPPDATA\Kitzur\app\deploy\windows\Kitzur.ps1"
   & $kitzur -Action Start
   & $kitzur -Action Status
   ```

   The proxy runs in the background; you can close PowerShell. It listens on `127.0.0.1:8270`.
4. For a new OpenCode setup use `%LOCALAPPDATA%\Kitzur\config\opencode.generated.json` as the
   administrator-approved config (for example set `OPENCODE_CONFIG` to that path before starting
   OpenCode). For existing setups merge its provider/model/compaction fields into your current config;
   do not replace other settings. Select the `kitzur/<gateway model ID>` model. Supply
   `GATEWAY_API_KEY` to OpenCode through your approved credential mechanism; the template references
   the environment, never a literal key. Project settings can override global settings. Your admin
   should verify the effective provider routes through Kitzur. No individual benchmark run is required.

For multiple models, put each exact gateway model ID in the OpenCode provider's `models`
map. Route `small_model` through that Kitzur provider if it should be compacted. For
example, Qwen may use context 252000/output 32000; GPT-OSS may use context 131071/output
32000. Qwen has clientPoint 200000 and hard limit 193000; GPT-OSS has
planMaxTokens 32000 and hard limit 92071.

Use `-Action Stop` to stop accepting requests and drain active requests for up to 30 seconds.
`-Action Start` starts it again. `-Action Diagnose` writes a safe count-only report in
`%LOCALAPPDATA%\Kitzur\logs\diagnostics.json`. Share that report and OpenCode UI compaction counts/
timestamps with your administrator through the approved process. Do not share session content, raw
logs, config with credentials, or raw `/status`. Seeing `guard_fallback` or `engineExceptions` increase
needs admin investigation. Installation success alone does not confirm compaction works.

To upgrade, Stop first, then verify/extract the new release and rerun its installer. Config and the
existing generated OpenCode file are preserved. Changed profile/tokenizer requires admin migration.
If startup is disabled by organisational policy, use `-NoStartup` at install and run Start yourself.
The login launcher runs only while you are logged in; Windows logoff may end requests immediately.

To uninstall run `& $kitzur -Action Uninstall`. This stops the proxy and removes the login shortcut.
Remove Kitzur's provider selection from OpenCode, then delete `%LOCALAPPDATA%\Kitzur` when you no
longer need its config/state/logs. Node and OpenCode are managed separately.

## Ad-hoc npm / offline installs

Outside the managed bundle, use Node.js 22+ and a config file:

```powershell
kitzur autostart install --config 'C:\Kitzur config\kitzur.jsonc'
kitzur autostart status
kitzur autostart run --config 'C:\Kitzur config\kitzur.jsonc'
kitzur autostart remove
```

Install creates a per-user Startup-folder `Kitzur.lnk` targeting `node.exe` directly, with a
minimised window. It needs no admin rights or execution-policy change. The config path is saved
as absolute; keep Node, the CLI and config in place. `run` starts `serve` detached and hidden,
appending output to `<stateDir>\\logs\\serve-stdio.log`; it exits successfully if Kitzur already
answers on the configured port and refuses other listeners. Removal deletes the shortcut but does
not stop a running proxy. If PowerShell/COM is blocked, install prints manual Explorer shortcut
steps. This is separate from `Register-Startup.ps1`; use one method per user.
