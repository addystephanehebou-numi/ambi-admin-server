# ambi-admin-server

## Resuming a Claude Code session

Claude Code saves each conversation under the folder it was started in. The
ambi sessions are started from the parent `ambi/` folder (the one that holds
`ambi-client`, `ambi-server` and `ambi-admin`), so resume from there, not from
inside this repo:

```bash
cd ~/"Local Documents/Apps/ambi"

claude --continue        # reopen the most recent conversation (short: claude -c)
claude --resume          # pick from a list of past conversations (short: claude -r)
claude --resume <id>     # reopen one specific conversation by its session ID
```

Already inside Claude Code? Type `/resume` to switch to a past conversation.

Started from the wrong folder and your session isn't listed? Quit, `cd` into
`ambi/` and run `claude --resume` again.
