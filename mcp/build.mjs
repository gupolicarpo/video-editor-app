import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['@volcengine/tos-sdk'],
  outfile: 'dist/index.js',
  // Some bundled deps reference `require`; provide it in the ESM output.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  }
})
console.log('MCP server bundled -> dist/index.js')
