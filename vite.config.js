import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

// __BUILD_COMMIT__/__BUILD_TIME__ are replaced with literal values at build
// time, so the on-screen build indicator always reflects the deployed commit
// without needing a hand-maintained version number.
export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(getCommitHash()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // three itself is a large library; splitting it into its own chunk
    // (below) is the actual fix — this just stops Vite from re-flagging
    // that now-isolated, unavoidably-large vendor chunk as a problem.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        // three (plus its addons: OrbitControls/TransformControls/GLTFLoader,
        // all imported from src/main.js) is the only dependency and rarely
        // changes between deploys, unlike the app code that imports it —
        // splitting it into its own chunk keeps it a stable, cacheable asset
        // across deploys instead of being invalidated by every src/ change.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
