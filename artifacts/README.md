# Artifacts

`emoji-offline/` is the MakeEmoji offline pack used by `/emoji`. It is **not**
committed (too large). Populate it with:

```bash
npm run emoji:fetch
```

Railway/postinstall runs the same script automatically unless `EMOJI_SKIP_FETCH=1`.
