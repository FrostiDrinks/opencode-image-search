## How it works

When you drop an image into OpenCode, the image's base64 data is stored in OpenCode's SQLite database. This tool queries that database directly to retrieve the data URI, then uses [`image-search-mcp`](https://pypi.org/project/image-search-mcp/) to reverse image search without requiring agents to handle full URI data themselves.

---

## Usage

### macOS / Linux

Install:
```sh
mkdir -p ~/.config/opencode/tools
curl -Lo ~/.config/opencode/tools/image-search.ts \
  https://raw.githubusercontent.com/FrostiDrinks/opencode-image-search/main/image-search.ts
```
Remove:
```sh
rm ~/.config/opencode/tools/image-search.ts
```

### Windows (PowerShell)

Install:
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\tools"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/FrostiDrinks/opencode-image-search/main/image-search.ts" -OutFile "$env:USERPROFILE\.config\opencode\tools\image-search.ts"
```

Remove:
```powershell
Remove-Item "$env:USERPROFILE\.config\opencode\tools\image-search.ts"
```

Agents will automatically see the tool in new sessions and can call it using either the filename or chronological index of the desired image.
