import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const directory = "src-tauri/icons";
mkdirSync(directory, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function chunk(type, data) {
  const label = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([label, data])) {
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, label, data, checksum]);
}

function png(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const radius = size * 0.19;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nearestX = Math.max(radius, Math.min(size - radius, x + 0.5));
      const nearestY = Math.max(radius, Math.min(size - radius, y + 0.5));
      const inSquare = Math.hypot(x + 0.5 - nearestX, y + 0.5 - nearestY) <= radius;
      const inLetter = x >= size * 0.32 && x < size * 0.43 && y >= size * 0.25 && y < size * 0.64
        || x >= size * 0.32 && x < size * 0.68 && y >= size * 0.55 && y < size * 0.66;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      pixels[offset] = inLetter ? 255 : 42;
      pixels[offset + 1] = inLetter ? 255 : 79;
      pixels[offset + 2] = inLetter ? 255 : 190;
      pixels[offset + 3] = inSquare ? 255 : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const images = new Map([16, 32, 48, 128, 256, 512].map((size) => [size, png(size)]));
for (const [name, size] of [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512]
]) {
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
