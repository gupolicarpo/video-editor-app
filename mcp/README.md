# Video Editor MCP — Claude e Codex como produtores

Um único servidor MCP permite que **Claude Desktop**, **Claude Code** e **Codex** operem o editor:
importar mídia, montar a timeline, adicionar texto, transições, efeitos e animações, melhorar vídeo e
áudio, gerar com IA e exportar.

O servidor edita o mesmo projeto aberto no aplicativo (`autosave.vedit.json`). O editor detecta a
mudança, recarrega automaticamente e permite desfazer a última alteração externa.

## Gerar o servidor e a extensão

Na pasta `mcp`:

```bash
npm install
npm run package
```

Esse comando gera:

- `dist/index.js` — servidor compartilhado por Claude Code e Codex.
- `video-editor.mcpb` — instalador da extensão para Claude Desktop.

## Qual arquivo cada aplicativo usa

| Aplicativo | Configuração deste projeto | O que fazer |
|---|---|---|
| Claude Desktop | `mcp/video-editor.mcpb` | Instalar em **Configurações → Extensões → Configurações avançadas → Instalar extensão** |
| Claude Code | `.mcp.json` | Abrir esta pasta e aprovar o servidor `video-editor` quando solicitado |
| Codex Desktop/CLI | `.codex/config.toml` | Abrir esta pasta e aprovar o servidor `video-editor` quando solicitado |

O `.mcpb` é exclusivo do Claude Desktop. O Codex não precisa instalar esse arquivo: ele executa
diretamente `mcp/dist/index.js` pela configuração do projeto.

## Instalar ou atualizar no Claude Desktop

1. Abra **Claude Desktop → Configurações → Extensões**.
2. Abra **Configurações avançadas**.
3. Clique em **Instalar extensão**.
4. Selecione `mcp/video-editor.mcpb`.
5. Confirme a instalação ou atualização e abra uma nova conversa.

Também é possível dar duplo clique no `.mcpb` ou arrastá-lo para a janela do Claude Desktop.
Extensões privadas precisam ser instaladas novamente quando uma nova versão for gerada.

## Usar no Claude Code

O arquivo `.mcp.json` da raiz já registra o servidor para este projeto. Abra o projeto no Claude Code
e aceite a solicitação de confiança do MCP. O servidor também pode ser conferido com `/mcp`.

## Usar no Codex

O arquivo `.codex/config.toml` da raiz já registra o servidor para este projeto. Abra esta pasta no
Codex e aprove o MCP `video-editor` se a autorização aparecer. Não edite
`claude_desktop_config.json`: esse arquivo pertence ao método antigo do Claude Desktop e não configura
o Codex.

## Como funciona

- Projeto: `%APPDATA%\video-editor-app\autosave.vedit.json`, ou o caminho definido em
  `VEDIT_PROJECT`.
- Chaves Seedance/Veo/DeepSeek: lidas do `settings.json` salvo pelo próprio editor.
- Saída de IA: pasta de mídia configurada no aplicativo.
- Mantenha o editor aberto para acompanhar as alterações ao vivo.

## Ferramentas disponíveis

`get_project`, `set_project_settings`, `import_media`, `add_track`, `add_clip`, `add_text`,
`update_clip`, `set_transition`, `remove_clip`, `enhance_clip`, `add_effect`, `set_anim`,
`enhance_audio`, `apply_look`, `generate_video`, `generate_fx` e `render`.

### FX com Codex e HyperFrames

`generate_fx` recebe o HTML criado pelo Codex, renderiza localmente com HyperFrames e adiciona o
resultado à timeline. Por padrão gera WebM/VP9 transparente, adequado para títulos, lower-thirds,
partículas, gráficos e overlays. A composição HTML fica salva ao lado da mídia para revisões.

- Custo do HyperFrames local: zero; não usa chave de API.
- Requisitos: Node.js 22+, Chrome e o FFmpeg já incluído no projeto.
- Skills recomendadas no Codex: `/hyperframes` e `/motion-graphics`.

## Exemplo de pedido

> Crie um Short 1080×1920 de 15 segundos: importe `C:\videos\eu.mp4`, melhore a imagem,
> coloque o título “MEU CANAL” em amarelo no topo e exporte para `C:\videos\short.mp4`.
