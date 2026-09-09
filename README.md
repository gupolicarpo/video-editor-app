# Video Editor App

Editor de vídeo desktop para Windows (Electron + React + zustand + TypeScript), com timeline
multi-faixa de verdade, gravação de tela/webcam, efeitos e animações assados via FFmpeg, e um
servidor MCP que deixa o Claude editar a timeline por linguagem natural.

Documentação de arquitetura e as armadilhas já medidas estão em [CLAUDE.md](CLAUDE.md).

## Rodar

```bash
npm install
npm run setup    # baixa FFmpeg e o modelo de recorte (veja abaixo)
npm run dev      # hot-reload
npm start        # versão compilada
npm run build    # compilar
npm run dist     # gerar instalador (NSIS, sai em release/)
```

## Dependências binárias (não versionadas)

`npm run setup` baixa tudo sozinho e é idempotente — rodar de novo só confere o que já está no
lugar. Use `npm run setup -- --force` para rebaixar.

| caminho | o que é | tamanho |
|---|---|---|
| `vendor/ffmpeg/ffmpeg.exe`<br>`vendor/ffmpeg/ffprobe.exe` | FFmpeg 8.1 (build GPL da BtbN) — motor de render, enhance e normalização | ~170 MB compactado |
| `vendor/models/rvm_mobilenetv3_fp32.onnx` | [RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting), usado pelo ✂ Remover fundo | 15 MB |

Estão fora do repositório porque cada executável do FFmpeg tem ~200 MB, acima do limite de 100 MB
por arquivo do GitHub.

O script confere se o FFmpeg baixado traz `libx264`, `libvpx-vp9`, `libopus` e NVENC, e avisa se
faltar algum. Sem NVENC o app ainda exporta, só que pelo `libx264` na CPU, mais devagar.

**macOS e Linux:** não há build oficial equivalente, então o script procura o FFmpeg no `PATH` e
diz o que instalar se não achar (`brew install ffmpeg` / `sudo apt install ffmpeg`). O app resolve o
FFmpeg nesta ordem: variável de ambiente → `resources/` (empacotado) → `PATH`.

Opcionais, por recurso:

- **Transcrição local:** Python + `faster-whisper`
- **Remover fundo:** Python + `onnxruntime` (ou `onnxruntime-directml` para usar a GPU) + `numpy`

## Chaves de API

**Nenhuma chave é versionada.** Elas ficam só na máquina, em
`%APPDATA%/video-editor-app/settings.json`, gravadas pelo próprio app em ⚙ Configurações.
Luma, HeyGen, OpenAI e Kling ficam criptografadas em repouso (DPAPI, prefixo `enc:`);
Seedance, Veo e DeepSeek ficam em texto puro de propósito, porque o servidor MCP é um processo
Node puro e as lê direto.

## Servidor MCP

```bash
cd mcp && npm install && npm run build     # gera mcp/dist/index.js
node pack-extension.mjs                    # gera mcp/video-editor.mcpb
```

O MCP edita o mesmo arquivo de projeto que o app observa
(`%APPDATA%/video-editor-app/autosave.vedit.json`, ou o caminho em `VEDIT_PROJECT`), então o app
recarrega sozinho e mostra a edição ao vivo. Deixe o app aberto com `npm start`.

O Claude Code usa o `.mcp.json` da raiz — ele não é versionado porque guarda caminhos da
sua máquina. Copie o modelo: `cp .mcp.json.example .mcp.json`. O Claude Desktop precisa da extensão `.mcpb` — este build
ignora `mcpServers` no `claude_desktop_config.json`.

## Licença

MIT — veja [LICENSE](LICENSE). Você pode usar, modificar e distribuir, inclusive
comercialmente, mantendo o aviso de copyright.

FFmpeg e o modelo RobustVideoMatting têm licenças próprias e não são distribuídos
neste repositório.
