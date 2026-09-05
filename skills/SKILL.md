# Browser skill

1. `browser_observe` kind=snapshot to get `[eN]` refs.
2. `browser_act` action=open|click|fill|type|press|select|check|wait to interact.
3. `browser_observe` kind=screenshot (path) to verify visually.
4. `browser_extract` kind=text|table|query to scrape.

- Prefer batch: one browser_act with steps[] for fill+press flows.
- Never guess refs; re-snapshot after navigation.
- Large outputs are files; read the path, not the preview.
