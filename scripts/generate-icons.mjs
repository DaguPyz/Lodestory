import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { BLUE_PATH, BODY_PATH, VOID_PATH, BRAND_BLUE, BRAND_INK } from "../packages/ui/src/brandLogoGeometry.mjs";

// The desktop tile uses the same outline as the in-app mark, on a light tile
// so the approved dark ink stays legible in the operating system's dock.
const directory = "src-tauri/icons";
mkdirSync(directory, { recursive: true });
mkdirSync("assets/brand", { recursive: true });
writeFileSync("assets/brand/lodestory-mark.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 263">
  <path d="${BLUE_PATH}" fill="${BRAND_BLUE}"/>
  <path d="${BODY_PATH} ${VOID_PATH}" fill="${BRAND_INK}" fill-rule="evenodd"/>
</svg>\n`);

function png(size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect x="0" y="0" width="512" height="512" rx="97" fill="#f7f6f3"/>
    <g transform="translate(122 79) scale(1.34)">
      <path d="${BLUE_PATH}" fill="${BRAND_BLUE}"/>
      <path d="${BODY_PATH} ${VOID_PATH}" fill="${BRAND_INK}" fill-rule="evenodd"/>
    </g>
  </svg>`;
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
}

const images = new Map([16, 32, 48, 128, 256, 512].map((size) => [size, png(size)]));
for (const [name, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512]]) {
  writeFileSync(join(directory, name), images.get(size));
}

const icoSizes = [16, 32, 48, 256];
const icoHeader = Buffer.alloc(6 + icoSizes.length * 16);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoSizes.length, 4);
let offset = icoHeader.length;
for (const [index, size] of icoSizes.entries()) {
  const entry = 6 + index * 16;
  icoHeader[entry] = size === 256 ? 0 : size;
  icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(images.get(size).length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  offset += images.get(size).length;
}
writeFileSync(join(directory, "icon.ico"), Buffer.concat([icoHeader, ...icoSizes.map((size) => images.get(size))]));

const icnsTypes = [["icp4", 16], ["icp5", 32], ["ic07", 128], ["ic08", 256], ["ic09", 512]];
const icnsEntries = icnsTypes.map(([type, size]) => {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(8 + images.get(size).length, 4);
  return Buffer.concat([header, images.get(size)]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns");
icnsHeader.writeUInt32BE(8 + icnsEntries.reduce((total, entry) => total + entry.length, 0), 4);
writeFileSync(join(directory, "icon.icns"), Buffer.concat([icnsHeader, ...icnsEntries]));
