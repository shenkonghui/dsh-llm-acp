import { defineConfig, type UserConfig } from 'tsdown'
import { clientBundle } from './scripts/tsdown.client.ts'

/**
 * Combined build: host-side LLM adapter (node ESM) + client-side ACP Servers
 * settings UI (browser closure factory). The host entries are built from
 * `lib/types/` (tsc output); the client entry is built from source by the
 * shared `clientBundle` preset.
 */
const client = clientBundle('@deepseek-ai/dsh-llm-acp', ['lib/types/index.js', 'lib/types/invariant.js'])

/** Host node entries (index + invariant). */
const hostConfigs: UserConfig[] = [
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
]

export default defineConfig(({ env }) => {
  // Resolve the client config (it may be a function or array).
  const clientResolved = typeof client === 'function' ? client({ env }) : client
  const clientConfigs = Array.isArray(clientResolved) ? clientResolved : [clientResolved]
  return [...hostConfigs, ...clientConfigs]
})
