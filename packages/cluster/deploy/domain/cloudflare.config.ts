import { defineConfig } from 'cf/config'
const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(name + ' is required')
  return value
}
export default defineConfig({
  accountId: required('CLOUDFLARE_ACCOUNT_ID'),
  worker: {
    name: 'opencode-cluster-domain',
    entrypoint: './index.ts',
    compatibilityDate: '2026-10-20',
    domains: [required('CLUSTER_DOMAIN'), ...(process.env.CLUSTER_DOMAIN_ALIASES ?? '').split(',').filter(Boolean)],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: false },
  },
})
