# The Pigeon UI (Local Run)

This app should be served over HTTP. Opening `index.html` directly via `file://` can break:
- `default_set.json` loading
- `help.html` loading

## Run

1. In this folder, start the local server:

```bash
npm run dev
```

2. Open:

`http://127.0.0.1:8080`

## Notes

- No dependencies are required.
- Set a custom port with:

```bash
PORT=3000 npm run dev
```
