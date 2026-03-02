import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repoName = 'token-staking-interface'
const base = process.env.BASE_PATH ?? (process.env.GITHUB_ACTIONS === 'true' ? `/${repoName}/` : '/')

export default defineConfig({
  plugins: [react()],
  base,
})
