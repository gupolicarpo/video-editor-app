import { copyFileSync, rmSync, existsSync } from 'fs'
import { execSync } from 'child_process'

// Assumes `npm run build` already produced dist/index.js
copyFileSync('dist/index.js', 'extension/index.js')

const out = 'video-editor.mcpb'
if (existsSync(out)) rmSync(out)
if (existsSync('video-editor-tmp.zip')) rmSync('video-editor-tmp.zip')

// Zip the extension contents (manifest.json at the archive root).
execSync(
  'powershell -NoProfile -Command "Compress-Archive -Path extension\\* -DestinationPath video-editor-tmp.zip -Force"',
  { stdio: 'inherit' }
)
copyFileSync('video-editor-tmp.zip', out)
rmSync('video-editor-tmp.zip')
console.log('Extensão do Claude Desktop empacotada -> ' + out)
