const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

// Minimalist fountain pen nib -- gold on dark, elegant writing vibe
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#161616"/>
      <stop offset="100%" stop-color="#0f0f0f"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="#dfc06a"/>
      <stop offset="100%" stop-color="#b08930"/>
    </linearGradient>
  </defs>

  <!-- Background: rounded square -->
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <rect x="4" y="4" width="504" height="504" rx="92" fill="none" stroke="#2a2520" stroke-width="4"/>

  <!-- Fountain pen nib, angled -->
  <g transform="translate(256, 256) rotate(-45) translate(-256, -256)">
    <!-- Nib body -->
    <path d="
      M 256 90
      C 230 90, 210 110, 210 140
      L 210 300
      L 240 300
      L 248 420
      L 256 420
      L 264 420
      L 272 300
      L 302 300
      L 302 140
      C 302 110, 282 90, 256 90 Z
    " fill="url(#gold)" opacity="0.9"/>

    <!-- Center slit -->
    <line x1="256" y1="160" x2="256" y2="390" stroke="#0f0f0f" stroke-width="3" stroke-linecap="round"/>

    <!-- Ink hole -->
    <ellipse cx="256" cy="200" rx="12" ry="16" fill="#0f0f0f"/>

    <!-- Highlight edge -->
    <path d="
      M 256 90
      C 242 90, 228 100, 220 115
      L 220 280
      L 230 280
      L 230 130
      C 230 108, 242 98, 256 98 Z
    " fill="rgba(255,255,255,0.12)"/>
  </g>
</svg>
`;

// Build a minimal ICO file from PNG buffers
function buildIco(pngBuffers) {
  // ICO header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: 1 = ICO
  header.writeUInt16LE(pngBuffers.length, 4); // image count

  // Each directory entry: 16 bytes
  const dirSize = 16 * pngBuffers.length;
  let offset = 6 + dirSize;

  const dirs = [];
  for (const png of pngBuffers) {
    const dir = Buffer.alloc(16);
    // We'll set width/height to 0 which means 256 for ICO format
    // For sizes < 256, we'd set them explicitly, but PNG format in ICO handles this
    dir.writeUInt8(0, 0);   // width (0 = 256)
    dir.writeUInt8(0, 1);   // height (0 = 256)
    dir.writeUInt8(0, 2);   // color palette
    dir.writeUInt8(0, 3);   // reserved
    dir.writeUInt16LE(1, 4);  // color planes
    dir.writeUInt16LE(32, 6); // bits per pixel
    dir.writeUInt32LE(png.length, 8);  // image size
    dir.writeUInt32LE(offset, 12);     // image offset
    dirs.push(dir);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirs, ...pngBuffers]);
}

// Generate
const size = 256;
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
const pngBuffer = resvg.render().asPng();

// Save PNG
fs.writeFileSync(path.join(__dirname, '..', 'icon.png'), pngBuffer);
console.log('  icon.png (256x256)');

// Save ICO
const icoBuffer = buildIco([pngBuffer]);
fs.writeFileSync(path.join(__dirname, '..', 'icon.ico'), icoBuffer);
console.log('  icon.ico');

console.log('Done!');
