import { readFile, writeFile } from 'node:fs/promises'
const origin = process.env.CLUSTER_CANONICAL_ORIGIN
if (origin && (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin))
  throw new Error("CLUSTER_CANONICAL_ORIGIN must be an HTTPS origin without a trailing slash")
const assets = {
  canonicalOrigin: origin ?? null,
  html: await readFile(new URL('./landing.html', import.meta.url), 'utf8'),
  css: await readFile(new URL('./style.css', import.meta.url), 'utf8'),
  wordmark: await readFile(process.env.WORDMARK_PATH ?? new URL('../../assets/wordmark.svg', import.meta.url), 'utf8'),
  logo: await readFile(new URL('./liammendes.svg', import.meta.url), 'utf8'),
}
await writeFile(new URL('./assets.generated.mjs', import.meta.url), 'export default ' + JSON.stringify(assets) + ';\n')
