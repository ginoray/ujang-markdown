# Ujang Markdown

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ginoray/ujang-markdown/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ginoray/ujang-markdown/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free Markdown-to-HTML parser in a single `parse.js`. Its `parse(markdown)` returns byte-identical output to marked 18.1.3 with default options (GFM on), while rendering faster than marked itself. Written for the make.fun bounty "Make Markdown rendering faster" (markdown-render-speed-02).

## Run

The harness runs `node main.ts`. It reads `cases.json` from `MAKEFUN_INPUT_DIR` (default `/input`) and writes `html.json` to `MAKEFUN_OUTPUT_DIR` (default `/output`).

## License

MIT
