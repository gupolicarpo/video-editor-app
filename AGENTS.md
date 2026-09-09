# Video Editor App — contexto para o Codex

## Objetivo
Editor de vídeo **desktop** (Windows) feito para **substituir o FlexClip**, com timeline
**multi-faixa** de verdade (vídeos simultâneos), edição de vídeo/áudio, texto/legendas,
transições, "melhorar imagem", e **IA** (geração/edição com **Seedance 2.0**, geração com **Veo**,
e melhoria de prompt com **DeepSeek**).

**Meta atual:** usar o **Codex como produtor** — via um servidor **MCP**, o Codex edita a
timeline por linguagem natural (importar, cortar, texto, transições, enhance, gerar com IA, exportar)
e o app **recarrega sozinho** pra mostrar a edição ao vivo.

O usuário fala **português (Brasil)**. Abordagem: MVP primeiro, iterativo. Suas chaves de API são
dele e ficam **só na máquina** (`settings.json`).

## Como rodar
- **App:** `npm run dev` (hot-reload) ou `npm start` (versão compilada). Compilar: `npm run build`.
  Instalador: `npm run dist`. (FFmpeg 8 nativo já está no PATH; é o motor de render/enhance.)
- **MCP:** `cd mcp && npm install && npm run build` (gera `mcp/dist/index.js`).
  Empacotar extensão p/ Codex Desktop: `node pack-extension.mjs` (gera `mcp/video-editor.mcpb`).

## Estrutura
- `src/main/` — processo Electron: `index.ts` (janela, protocolo `media://` com Range, IPC),
  `ffmpeg.ts` (**motor**: probe, render multi-faixa com xfade, enhance com preservação de alfa,
  extractSegment — sem deps do Electron, reutilizado pelo MCP), `ai/index.ts` (Seedance 2.0 +
  DeepSeek), `settings.ts`, `project.ts` (salvar/abrir + autosave + watcher de recarga).
- `src/renderer/src/` — UI React: `store.ts` (zustand: clips/tracks/media + undo/redo + projeto),
  `types.ts`, `components/` (Timeline, Preview, Inspector, AIPanel, Toolbar, Settings/Export modais),
  `transitions.ts`, `textRender.ts`, `mediaTools.ts` (waveforms/thumbnails).
- `mcp/` — servidor MCP: `src/index.ts` (17 ferramentas), `src/project.ts` (lê/grava o MESMO
  arquivo de projeto do app + lê `settings.json`), `src/render.ts` (converte e chama o motor;
  texto via ffmpeg `drawtext`), `src/seedance.ts`. Bundle: `dist/index.js`. Extensão: `video-editor.mcpb`.

## MCP — Claude e Codex como produtores
- **Claude Desktop:** instala `mcp/video-editor.mcpb` em Configurações → Extensões → Configurações
  avançadas → Instalar extensão. O `.mcpb` é exclusivo do Claude Desktop.
- **Claude Code:** usa o `.mcp.json` da raiz e pede aprovação do MCP do projeto na primeira vez.
- **Codex Desktop/CLI:** usa `.codex/config.toml`; não usa `.mcpb` nem
  `claude_desktop_config.json`. Também pode pedir aprovação do MCP na primeira vez.
- Os três clientes executam o mesmo `mcp/dist/index.js`; não mantenha servidores duplicados.
- **Como funciona:** o MCP edita o arquivo de projeto que o app usa
  (`%APPDATA%/video-editor-app/autosave.vedit.json`, ou `VEDIT_PROJECT`). O app observa o arquivo e
  **recarrega** quando o MCP altera (mantenha o app aberto com `npm start` pra ver ao vivo).
  Usa as chaves salvas no app (⚙ Configurações): Seedance/DeepSeek.
- **Ferramentas (17):** `get_project`, `set_project_settings`, `import_media`, `add_track`,
  `add_clip`, `add_text`, `update_clip`, `set_transition`, `remove_clip`, `enhance_clip`,
  `add_effect`, `set_anim`, `enhance_audio`, `apply_look`, `generate_video` (Seedance gerar/editar),
  `generate_fx` (HyperFrames local, WebM transparente) e `render` (exportar MP4).
- **Fluxo típico:** `get_project` → `import_media` → `add_clip`/`add_text` → `set_transition`/
  `enhance_clip`/`generate_video` → `render`. Sempre confirme caminhos absolutos de arquivos.

## Estado atual (pronto e testado)
- Timeline multi-faixa, drag/trim/split, **multi-seleção (Shift/Ctrl+click) + drag em grupo**,
  **copiar/colar (Ctrl+C/V)**, nudge por frame (Alt+setas), zoom-to-fit ("⤢ Caber"),
  **mute/solo/lock por faixa** (vale no preview e no export), preview com scrubbing, PiP, agulha arrastável.
- Texto/legendas (rasterizado p/ PNG na exportação do app; `drawtext` no MCP).
- Áudio: volume, fade in/out, waveforms, ducking por sobreposição; separar áudio do vídeo;
  🎚 melhorar áudio (denoise/loudnorm/voz).
- Visual: velocidade, filtros de cor, transições **xfade reais**, efeitos de movimento (zoom punch,
  Ken Burns, pan…), **animações de elemento (in/loop/out + direção) — assadas no export via
  expressões ffmpeg** (fade alpha / overlay x-y / scale eval=frame / rotate / geq na alfa).
- **Conjunto de animações (paridade com o FlexClip), preview === export:**
  - **Entrada (23):** fade, popup, slideL/R/U/D, fall, zoom, rotate, grow, wipe, flip, flip3d,
    spin3d, bounce, jump, drift, dash, breath, heartbeat, scrapbook, tumble, stomp.
  - **Loop (16):** pulse, shake, sway, sway3d, wiggle, jiggle, float, jump, heartbeat, neon,
    spin, spin3d, flip, credits, creditsOnce, balloon — com **velocidade** (`loopSpeed`).
  - **Saída (21):** espelham as entradas (`Match In` / `Match Out` no Inspector geram o par).
  - Direção por grade de 8 setas + centro. `grow` ancora a **borda oposta** (barras crescem do eixo).
- Export: **NVENC (h264_nvenc) com fallback libx264**, **cancelável** (export:cancel), verificação
  de qualidade pré-export (risco de slideshow) + auto-revisão pós-export (ffprobe).
- "✨ Melhorar imagem" (preserva alfa), "🎬 Look de referência", 🪄 preencher corte (Kling/Seedance
  first+last frame), 🔁 Remake com referência (Luma/gpt-image-2), 🎤 HeyGen lip-sync, 🤖 Produtor IA
  (scoring de providers + orçamento com reserva/reconciliação).
- Projeto: salvar/abrir, **autosave atômico**, sessões nomeadas, undo/redo, chaves com auto-save.
- Segurança: `media://` só serve arquivos conhecidos (whitelist), reservas de orçamento órfãs são
  estornadas no boot.
- Confiabilidade: `npm run build` agora exige TypeScript limpo e roda um smoke test real com FFmpeg
  (transição, paridade do MCP e recuperação do autosave). O MCP renderiza `anim`/`mask` e respeita
  mute/solo; grava o projeto atomicamente com `.bak`. Alterações externas do Codex entram no undo
  e o app mostra `Salvando` / `Salvo` / `Erro ao salvar`.
- Instalador: `npm run dist` (electron-builder configurado; NSIS + ícone `app-icon.ico`, saída em `release/`),
  **FFmpeg/ffprobe embutidos** (vendor/ffmpeg → extraResources; resolução: env → resources → PATH).
- Timeline extra: **ripple delete** (Shift+Del / botão 🗑⇤), **loop de trecho no preview** (teclas I/O
  definem, U limpa, faixa azul na régua), **marcadores** (tecla M, ◆ na régua — clique vai, botão
  direito remove; persistem no projeto), **medidor de áudio** no transporte (via peaks; vídeos ≤10min
  também ganham peaks), tolerância de drift menor p/ áudio (0.08s).
- Chaves Luma/HeyGen/OpenAI/Kling **criptografadas em repouso** (safeStorage/DPAPI, prefixo `enc:`);
  Seedance/Veo/DeepSeek ficam em texto puro de propósito (o MCP, processo Node puro, as lê direto).
- **Transcrição local** (`src/main/transcribe.ts`, faster-whisper via Python — nada sai da máquina),
  com cache por arquivo+mtime. Painel "📝 Transcrição & corte por texto" no Inspector: clicar frase
  pula a agulha, detecta vícios de linguagem + silêncio morto e **corta fechando os buracos**
  (`cutSourceRanges`), exporta `.srt` (2 palavras/legenda, MAIÚSCULAS). Requer Python + faster-whisper.
- **🎯 Auto-corrigir cor**: mede o clipe (ffmpeg `signalstats`, percentis YLOW/YHIGH) e aplica
  correção **limitada a ±8%**, sem desvio de cor — só ajusta brilho/contraste/saturação do clipe
  (não destrutivo, aparece no preview). Ideias adaptadas de browser-use/video-use (MIT).
- **Micro-fade de 30ms** em toda borda de áudio sem fade do usuário — mata o "pop" nos cortes.
- **🎥 Gravar** (`src/main/record.ts` + `components/RecordPanel.tsx`): webcam+mic com seletor de fonte,
  trava exposição/foco/branco, grava VP9 e normaliza para H.264/AAC. Cai direto na biblioteca.
- **✂ Remover fundo** (`src/main/matte.ts` + `components/MattePanel.tsx`): RobustVideoMatting local
  (ONNX, `vendor/models/rvm_mobilenetv3_fp32.onnx`). Gera WebM/VP9 com alfa real; o motor já compõe.
  Requer Python com `onnxruntime` + `numpy`. Com `onnxruntime-directml` usa a GPU sozinho.

## Limitações / próximos passos
- Transição com clipe em PiP assume tela cheia no segmento do xfade (caso comum: clipes full-frame).
- Ducking é por sobreposição (não sidechain). HEVC/H.265 pode não tocar no preview (Chromium).
- Sem keyframes / speed ramping ainda. Texto no render do MCP (drawtext) difere um pouco do canvas
  do app. Anima-se o clipe inteiro — não há animação de sub-partes de uma camada.
- Animações de loop têm **`loopSpeed`** (0,1×–4×; spin = 1 volta a cada `3/loopSpeed` s), idêntico no
  preview e no export.
- Entrada **`grow`**: escala num eixo ancorando a borda oposta (`inDir: 'up'` = barra cresce com o pé
  fixo). Feito com escala pelo centro + translate compensatório (não `transform-origin`, que
  re-origina rotação/efeitos na mesma camada). ⚠️ A âncora é a **borda da camada**, não o desenho
  dentro dela — o pé da barra precisa encostar na borda inferior do PNG.

### Armadilhas de gravação e recorte de fundo (medidas, não supostas)
- **`applyConstraints({advanced:[{exposureMode:'manual'}]})` resolve com sucesso e não faz nada.**
  Constraint em `advanced` é best-effort; o Chromium descarta em silêncio. Só cola quando o **valor
  vai junto** (`exposureMode:'manual'` **+** `exposureTime`). Sempre reler `getSettings()` depois.
- **Janela oculta congela timers** (background throttling). Uma janela de teste `show:false` capturou
  17fps em vez de 30. `backgroundThrottling: false` na janela principal.
- **O WebM do `MediaRecorder` mente duas vezes:** `duration=N/A` (clipe entra com duração 0) e é VFR
  (reencodado direto vira `r_frame_rate=2000/1`). `-fps_mode cfr -r <fps real>` conserta. `+genpts`
  é irrelevante — testado.
- **A câmera para de entregar quadros antes do microfone** (0,586s medidos na C920), então o vídeo
  acabava antes do áudio. `tpad=stop_mode=clone` + `-shortest` fecha o buraco (0,003s de resto).
- **O ffmpeg escreve alfa em VP9 e o decoder nativo `vp9` não o lê.** O arquivo sai com
  `alpha_mode=1` correto, mas só `-c:v libvpx-vp9` expõe o plano. `detectVpxAlpha` já cuida disso no
  motor. Nunca confie no `pix_fmt` reportado pelo ffprobe para julgar se há alfa.
- **RVM > BiRefNet para vídeo, medido no material real:** 0,119 s/quadro contra 27,0 (CPU), borda
  estável (estado recorrente) contra fervendo, e o BiRefNet ainda engoliu a cadeira atrás do ombro.
  O RVM devolve `fgr` já descontaminado — não recomponha com os pixels crus da câmera.
- **Planar dos dois lados (`gbrp`/`gbrap`), nunca `rgb24`/`rgba`.** O RVM come NCHW; intercalado custa
  um transpose por quadro em cada sentido e deixa o ORT com tensor não-contíguo. Medido: 169,6 → 76,5
  ms/quadro (**2,22×**), e a inferência sozinha cai 92 → 46 ms. Ordem dos planos: **G, B, R, A**.
- **`ort.get_available_providers()` põe `AzureExecutionProvider` primeiro** — é stub de inferência
  remota, não roda uma operação. Peça explicitamente CUDA → DirectML → CPU.
- **DirectML `device_id=0` é a NVIDIA nesta máquina** (identificado pela alocação em `nvidia-smi`,
  não pela ordem). `io_binding` para manter o estado recorrente na GPU rende só 1,07× — não vale.

### Armadilhas do `animFilters` (custaram bugs de verdade — não desfaça)
- **`rotate` resolve `ow`/`oh` UMA vez, na configuração.** Se um `scale=eval=frame` vier antes, a
  caixa congela no tamanho do primeiro frame e o elemento nunca chega ao tamanho final (tumble
  terminava em 50% do tamanho). Por isso a ordem é `wipe → rotate → scale`, e o `pad` da rotação usa
  **pixels literais**, nunca `iw`.
- **A margem do `pad` de rotação tem de ser PAR.** O `overlay` alinha croma em offsets pares; margem
  ímpar inverte a paridade do `x`/`y` e arrasta a camada 1px em relação ao mesmo clipe sem rotação.
- **Offsets de translação usam `cw`/`ch` (constantes), não `w`/`h` do overlay.** `translate%` no CSS é
  relativo à caixa **sem escala**; usar `w` faria um slide viajar mais quando houvesse zoom junto.
- Rotação recebe padding √2 antes do `rotate` — senão os cantos são ceifados.
- Verificado medindo frames renderizados (bbox/área/centroide), não só "renderizou sem erro":
  todas as 23 entradas terminam no mesmo tamanho, as 21 saídas somem, e clipe girando fica
  pixel-a-pixel na mesma posição de um não-girado.
- `flip`/`flip3d`/`spin3d`/`sway3d` são **aproximações ortográficas** (`scaleX = cos θ`) — o ffmpeg não
  faz 3D real; não há perspectiva/foreshortening.
- `wipe` e `neon` usam `geq` na alfa (por pixel) — **caro**; evite em clipes longos/4K.
- `credits` e `balloon` dão a volta com um **teletransporte** (sem crossfade na emenda).
- **MCP (17 ferramentas)** agora inclui `add_effect`, `set_anim`, `enhance_audio`, `apply_look` e
  `generate_fx` (HyperFrames local);
  ainda não expõe gap-fill/remake (dependem de módulos com Electron).
- **Seedance API não serve para material com o rosto do usuário.** A moderação da BytePlus recusa
  imagem com pessoa real: `InputImageSensitiveContentDetected.PrivacyInformation` ("the input image
  may contain real person"). Verificado 25/06 e **de novo em 08/07** — a recusa acontece na submissão,
  antes de gerar, então **não custa nada** re-testar (`scratchpad/seedance-face-test.cjs`). O Runway
  hospeda o mesmo modelo com moderação mais frouxa: o preço alto é do **portão**, não do Seedance.
- **`generateSeedance` modo `edit` só aceita URL pública.** A API exige `role: 'reference_video'` no
  item de vídeo e recusa data URL (`reference_video must be provided as a web url`) — ao contrário de
  `image_url`, que aceita. O app agora falha com mensagem clara em vez de mandar data URL e levar 400.

## Referência de API
- Seedance 2.0 (Ark/Volcengine): `POST {base}/contents/generations/tasks`, modelo
  `doubao-seedance-2-0-260128`, `content[]` multimodal (text/image_url/video_url), poll do task →
  `content.video_url`. Detalhes em `src/main/ai/index.ts`.
