# Watching compaction happen: a scripted agent grows a session through the proxy and
# `kitzur status` reports the compaction. The upstream is a stub. Re-record with record.sh.
Output ../compaction.gif
Output ../compaction.mp4

Set Shell "bash"
Set FontSize 17
Set Width 1100
Set Height 700
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type `source /tmp/kitzur-demo/env-running.sh`
Enter
Sleep 4s
Show

Type "# a 32k window; the agent keeps reading files"
Enter
Type "node drive.mjs http://127.0.0.1:8270/v1 12 500"
Enter
Sleep 9s
Type "kitzur status"
Enter
Sleep 2s
Type "curl -s localhost:8270/status | jq .last_compaction"
Enter
Sleep 5s
