# Quick start: write a config, point it at an upstream, start the proxy, check it.
# The upstream is a stub (mock-upstream.mjs), not a model. Re-record with record.sh.
Output ../quickstart.gif
Output ../quickstart.mp4

Set Shell "bash"
Set FontSize 17
Set Width 1100
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set PlaybackSpeed 1

Hide
Type `source /tmp/kitzur-demo/env.sh`
Enter
Sleep 500ms
Show

Type "kitzur config init --preset 32k --out kitzur.jsonc"
Enter
Sleep 1.5s

Type "# point it at an upstream and a tokenizer"
Enter
Type `sed -i.bak 's|"origin": null|"origin": "http://127.0.0.1:8000"|; s|"path": null|"path": "tokenizer.json"|' kitzur.jsonc`
Enter
Type "node mock-upstream.mjs 8000 &   # demo upstream: a stub, not a model"
Enter
Sleep 800ms
Type "kitzur config validate -c kitzur.jsonc"
Enter
Sleep 1.5s

Type "kitzur serve -c kitzur.jsonc &"
Enter
Sleep 1.5s
Type "kitzur status"
Enter
Sleep 4s
