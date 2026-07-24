/**
 * 从 build/logo/*.svg 生成应用图标(build/icon.icns + build/icon.png)。
 *
 * 单一来源是手写的分档 SVG;本脚本负责套 macOS 图标底板、光栅化、组装 icns。
 * 依赖 rsvg-convert(brew install librsvg)与 iconutil(macOS 自带);
 * 产物已提交进仓库,所以打包机上不需要这两个工具,只有改图时才要跑。
 *
 *   npm run icons:gen
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const LOGO = join(ROOT, 'build', 'logo')
const OUT = join(ROOT, 'build')
const TMP = join(ROOT, 'node_modules', '.cache', 'duetlens-icons')

/** macOS Big Sur 图标栅格:1024 画布里 824 的圆角方,圆角半径为其 22.5%。 */
const CANVAS = 1024
const PLATE = 824
const PLATE_R = PLATE * 0.225

/** 各变体可见内容在 96 画布里的实际跨度,用来把它们的视觉体量对齐。 */
const VARIANTS = {
  full: { file: 'mark.svg', span: 76 },
  small: { file: 'mark-small.svg', span: 72 },
  tiny: { file: 'mark-tiny.svg', span: 75 },
} as const

/** 可见内容占底板的比例。 */
const CONTENT = 0.76

function variantFor(px: number): keyof typeof VARIANTS {
  if (px >= 128) return 'full'
  return px > 16 ? 'small' : 'tiny'
}

const ICONSET: Array<[string, number]> = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

function markBody(file: string): string {
  const svg = readFileSync(join(LOGO, file), 'utf8')
  const open = svg.indexOf('>', svg.indexOf('<svg'))
  return svg.slice(open + 1, svg.lastIndexOf('</svg>'))
}

function compose(variant: keyof typeof VARIANTS): string {
  const { file, span } = VARIANTS[variant]
  const scale = (PLATE * CONTENT) / span
  const offset = (CANVAS - 96 * scale) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2130"/>
      <stop offset="1" stop-color="#0c0f16"/>
    </linearGradient>
  </defs>
  <rect x="${(CANVAS - PLATE) / 2}" y="${(CANVAS - PLATE) / 2}" width="${PLATE}" height="${PLATE}" rx="${PLATE_R}" fill="url(#plate)"/>
  <rect x="${(CANVAS - PLATE) / 2 + 1.5}" y="${(CANVAS - PLATE) / 2 + 1.5}" width="${PLATE - 3}" height="${PLATE - 3}" rx="${PLATE_R - 1.5}" fill="none" stroke="#ffffff" stroke-width="3" opacity=".08"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${markBody(file)}</g>
</svg>
`
}

function render(variant: keyof typeof VARIANTS, px: number, dest: string): void {
  const src = join(TMP, `${variant}.svg`)
  execFileSync('rsvg-convert', ['-w', String(px), '-h', String(px), '-o', dest, src])
}

rmSync(TMP, { recursive: true, force: true })
const iconset = join(TMP, 'icon.iconset')
mkdirSync(iconset, { recursive: true })

for (const variant of Object.keys(VARIANTS) as Array<keyof typeof VARIANTS>) {
  writeFileSync(join(TMP, `${variant}.svg`), compose(variant))
}

// 同一像素尺寸可能对应两个 iconset 条目(如 32 = 16@2x 与 32),只渲染一次再复制。
const rendered = new Map<number, string>()
for (const [name, px] of ICONSET) {
  const dest = join(iconset, name)
  const done = rendered.get(px)
  if (done) {
    copyFileSync(done, dest)
    continue
  }
  render(variantFor(px), px, dest)
  rendered.set(px, dest)
}

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(OUT, 'icon.icns')])
render('full', 1024, join(OUT, 'icon.png'))

console.log('build/icon.icns · build/icon.png 已生成')
