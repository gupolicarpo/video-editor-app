# Gerar a versão macOS

O código já está preparado para macOS. **Estes passos precisam rodar num Mac** —
não é possível gerar um app de Mac a partir do Windows (o `.dmg` exige
ferramentas do próprio sistema, e a assinatura exige o Xcode).

## 1. Pré-requisitos no Mac

```bash
# Node 18+ (se ainda não tiver)
brew install node

# FFmpeg — veja o passo 2 se preferir embutir em vez de instalar
brew install ffmpeg
```

## 2. FFmpeg: embutir ou usar o do sistema

O app procura o binário nesta ordem: **variável de ambiente → cópia embutida →
PATH do sistema**. Então há duas opções:

- **Mais simples:** deixar `vendor/ffmpeg-mac/` vazio e usar o `brew install ffmpeg`.
  Funciona, mas quem receber o app também precisa ter o ffmpeg instalado.
- **Para distribuir:** baixar os binários em <https://evermeet.cx/ffmpeg/> e colocar
  `ffmpeg` e `ffprobe` (sem extensão) em `vendor/ffmpeg-mac/`, depois:

  ```bash
  chmod +x vendor/ffmpeg-mac/ffmpeg vendor/ffmpeg-mac/ffprobe
  ```

  Atenção: os binários são específicos de arquitetura. Para gerar um app
  universal (Intel + Apple Silicon) você precisa dos binários universais, ou
  gerar um `.dmg` por arquitetura.

## 3. Compilar

```bash
npm install
npm run build
npx electron-builder --mac
```

Saída em `release/`: um `.dmg` e um `.zip` para `arm64` e `x64`.

## 4. Abrir sem assinatura da Apple

Sem uma conta Apple Developer (US$ 99/ano), o app **não é assinado nem
notarizado** — o Gatekeeper vai bloquear com *"o app está danificado"*.

Para abrir mesmo assim:

- Botão direito no app → **Abrir** → **Abrir** de novo, **ou**
- ```bash
  xattr -cr "/Applications/Video Editor.app"
  ```

Para distribuir sem esse atrito, é preciso assinar e notarizar:

```bash
export APPLE_ID="seu@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
npx electron-builder --mac   # com o certificado "Developer ID Application" instalado
```

## 5. Permissões do macOS

Já estão declaradas em `build/entitlements.mac.plist` e no `extendInfo` do
`package.json`. Na primeira execução o sistema vai pedir:

- **Câmera** e **Microfone** — ao abrir o painel Gravar
- **Gravação de Tela** — para os modos "Só tela" e "Tela + câmera".
  Este precisa ser liberado à mão em *Ajustes → Privacidade e Segurança →
  Gravação de Tela*, e **o app precisa ser reiniciado** depois.

## 6. Recursos opcionais (dependem de Python)

Transcrição e remoção de fundo chamam `python3` (o código já usa `python3` fora
do Windows):

```bash
pip3 install faster-whisper
pip3 install onnxruntime numpy      # remoção de fundo
```

No Mac a remoção de fundo roda em **CPU** — o DirectML usado no Windows é
exclusivo da NVIDIA. Fica bem mais lento. Trocar para CoreML
(`onnxruntime-silicon`) é possível, mas ainda não está implementado.

## O que muda em relação ao Windows

| recurso | macOS |
|---|---|
| Codificação por hardware | `h264_videotoolbox` (em vez de NVENC) — já automático |
| NVIDIA Broadcast | **não existe**; a opção some sozinha da interface |
| Remoção de fundo | CPU, sem aceleração DirectML |
| Chaves de API | Keychain do macOS (`safeStorage`) — equivalente ao DPAPI |
| Instalador | `.dmg` / `.zip` (em vez de NSIS `.exe`) |
