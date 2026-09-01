import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUTPUT_PATH = "packs/TreePhysics/RP/textures/colormap/foliage_fixed.tga";
const WIDTH = 8;
const HEIGHT = 2;
const CHERRY_GROVE = [0xb6, 0xdb, 0x61];
const PALE_GARDEN = [0x87, 0x8d, 0x76];

const image = Buffer.alloc(18 + WIDTH * HEIGHT * 4);
image[2] = 2; // Uncompressed true-color TGA.
image.writeUInt16LE(WIDTH, 12);
image.writeUInt16LE(HEIGHT, 14);
image[16] = 32;
image[17] = 0x28; // 8-bit alpha, top-left origin.

let offset = 18;
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const [red, green, blue] = x < WIDTH / 2 ? CHERRY_GROVE : PALE_GARDEN;
    image[offset++] = blue;
    image[offset++] = green;
    image[offset++] = red;
    image[offset++] = 0xff;
  }
}

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, image);
console.warn("[generate:foliage-fixed-palette] 8x2 cherry_grove/pale_garden");
