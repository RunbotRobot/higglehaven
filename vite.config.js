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
});
