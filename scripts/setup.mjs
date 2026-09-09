#!/usr/bin/env node
// Baixa os binários que não cabem no repositório: FFmpeg (201 MB cada executável,
// acima do limite de 100 MB do GitHub) e o modelo do RobustVideoMatting.
//
// Rode com `npm run setup`. É idempotente: o que já estiver no lugar e funcionando
// é pulado. Use `--force` para baixar de novo.
//
// Sem dependências de propósito — quem acabou de clonar ainda não rodou `npm install`.
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat, readdir, copyFile, mkdtemp } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = process.env.VEDIT_VENDOR_DIR || join(RAIZ, 'vendor')
const FORCE = process.argv.includes('--force')
const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''

// Build GPL da BtbN: traz libx264, libvpx-vp9, libopus e os encoders NVENC —
// tudo que o motor de render usa. A gyan.dev só publica o full build em .7z,
// que exigiria um extrator externo.
//
// Fixado no ramo n8.1, não no `master`: o app é escrito contra o FFmpeg 8 e o
// nightly do master pode mudar comportamento de filtro sem aviso. Este ramo
// continua recebendo correções dentro da série 8.
const FFMPEG_ZIP =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip'
const MODELO = {
  url: 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx',
  destino: join(VENDOR, 'models', 'rvm_mobilenetv3_fp32.onnx'),
  bytes: 14980000 // aproximado; serve só para detectar download truncado
}

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const aviso = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`)
const erro = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const mb = (n) => (n / 1e6).toFixed(1) + ' MB'

async function existe(p) {
  try {
    return (await stat(p)).size
  } catch {
    return 0
  }
}

async function baixar(url, destino, rotulo) {
  await mkdir(dirname(destino), { recursive: true })
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} ao baixar ${url}`)
  const total = Number(r.headers.get('content-length')) || 0
  let lidos = 0
  let ultimo = 0
  const corpo = Readable.fromWeb(r.body)
  corpo.on('data', (c) => {
    lidos += c.length
    const agora = Date.now()
    if (agora - ultimo > 500) {
      ultimo = agora
      const pct = total ? ` (${((lidos / total) * 100).toFixed(0)}%)` : ''
      process.stdout.write(`\r  ↓ ${rotulo}: ${mb(lidos)}${pct}   `)
    }
  })
  await pipeline(corpo, createWriteStream(destino))
  process.stdout.write(`\r${' '.repeat(60)}\r`)
  return lidos
}

function extrairZip(zip, destino) {
  // bsdtar do próprio Windows lê zip. Caminho absoluto porque no Git Bash o
  // `tar` do PATH é o GNU tar, que não lê zip.
  const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  let r = spawnSync(bsdtar, ['-xf', zip, '-C', destino], { stdio: 'ignore' })
  if (r.status === 0) return
  r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destino}' -Force`],
    { stdio: 'ignore' }
  )
  if (r.status !== 0) throw new Error('não consegui extrair o zip (tentei bsdtar e Expand-Archive)')
}

async function acharNoZip(raiz, nome) {
  for (const e of await readdir(raiz, { withFileTypes: true })) {
    const p = join(raiz, e.name)
    if (e.isDirectory()) {
      const achado = await acharNoZip(p, nome)
      if (achado) return achado
    } else if (e.name.toLowerCase() === nome.toLowerCase()) {
      return p
    }
  }
  return null
}

function versaoFfmpeg(bin) {
  const r = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  return { versao: (r.stdout.split('\n')[0] || '').trim(), config: r.stdout }
}

function conferirRecursos(config) {
  const precisa = ['libx264', 'libvpx', 'libopus']
  const faltando = precisa.filter((p) => !config.includes(p))
  if (faltando.length) aviso(`este FFmpeg não tem: ${faltando.join(', ')} — alguns recursos vão falhar`)
  else ok('libx264, libvpx-vp9 e libopus presentes')
  if (config.includes('nvenc') || config.includes('cuda')) ok('NVENC disponível (exportação por GPU)')
  else aviso('sem NVENC — a exportação cai no libx264 por CPU, mais lento')
}

async function ffmpegDoPath() {
  const v = versaoFfmpeg('ffmpeg')
  if (!v) return false
  ok(`FFmpeg já no PATH: ${v.versao}`)
  conferirRecursos(v.config)
  return true
}

async function passoFfmpeg() {
  console.log('\nFFmpeg')
  const dir = join(VENDOR, 'ffmpeg')
  const bin = join(dir, 'ffmpeg' + EXE)

  if (!FORCE && (await existe(bin))) {
    const v = versaoFfmpeg(bin)
    if (v) {
      ok(`já instalado: ${v.versao}`)
      conferirRecursos(v.config)
      return
    }
    aviso('vendor/ffmpeg existe mas não executa — baixando de novo')
  }

  if (!WIN) {
    // Não há build oficial de macOS/Linux com a mesma configuração; o app resolve
    // pelo PATH, então basta instalar pelo gerenciador de pacotes.
    if (await ffmpegDoPath()) return
    erro('FFmpeg não encontrado.')
    console.log(
      process.platform === 'darwin'
        ? '    Instale com:  brew install ffmpeg'
        : '    Instale com:  sudo apt install ffmpeg   (ou o equivalente da sua distro)'
    )
    return
  }

  const tmp = await mkdtemp(join(tmpdir(), 'vedit-ffmpeg-'))
  try {
    const zip = join(tmp, 'ffmpeg.zip')
    const n = await baixar(FFMPEG_ZIP, zip, 'FFmpeg')
    if (n < 50e6) throw new Error(`download incompleto (${mb(n)})`)
    extrairZip(zip, tmp)
    await mkdir(dir, { recursive: true })
    for (const nome of ['ffmpeg.exe', 'ffprobe.exe']) {
      const achado = await acharNoZip(tmp, nome)
      if (!achado) throw new Error(`${nome} não veio no pacote`)
      await copyFile(achado, join(dir, nome))
    }
    const v = versaoFfmpeg(bin)
    if (!v) throw new Error('o executável baixado não roda')
    ok(`instalado: ${v.versao}`)
    conferirRecursos(v.config)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function passoModelo() {
  console.log('\nModelo RobustVideoMatting (✂ Remover fundo)')
  const tam = await existe(MODELO.destino)
  if (!FORCE && tam > MODELO.bytes * 0.95) {
    ok(`já instalado (${mb(tam)})`)
    return
  }
  const n = await baixar(MODELO.url, MODELO.destino, 'modelo RVM')
  if (n < MODELO.bytes * 0.95) throw new Error(`download incompleto (${mb(n)})`)
  ok(`instalado (${mb(n)})`)
}

async function main() {
  console.log('Preparando as dependências binárias do Video Editor App')
  console.log(`destino: ${VENDOR}`)
  let falhou = false
  for (const passo of [passoFfmpeg, passoModelo]) {
    try {
      await passo()
    } catch (e) {
      falhou = true
      erro(e.message)
    }
  }
  console.log(
    falhou
      ? '\nTerminou com pendências — veja os ✗ acima.'
      : '\nPronto. Agora: npm install && npm run dev'
  )
  process.exit(falhou ? 1 : 0)
}

main().catch((e) => {
  erro(e.stack || e.message)
  process.exit(1)
})
