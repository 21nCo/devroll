/**
 * A minimal TrueType font in which every printable ASCII character is a solid 500 x 700 block on a 700-unit advance,
 * as a `data:` URL: text in it looks nothing like text in any fallback font, so a screenshot shows which was used.
 */
export function blockFontUrl(family: string): string {
  const glyphs = 1 + (0x7e - 0x20 + 1);
  const u16 = (...values: number[]): number[] => values.flatMap((value) => [(value >> 8) & 0xff, value & 0xff]);
  const u32 = (...values: number[]): number[] => values.flatMap((value) => [...u16((value >>> 16) & 0xffff), ...u16(value & 0xffff)]);
  // One contour, clockwise: (100,0) (100,700) (600,700) (600,0), all on the curve, coordinates as 16-bit deltas.
  const block = [...u16(1, 100, 0, 600, 700), ...u16(3, 0), 1, 1, 1, 1, ...u16(100, 0, 500, 0), ...u16(0, 700, 0, 0x10000 - 700), 0, 0];
  const names = [[1, family], [2, "Regular"], [3, family], [4, family], [6, family.replace(/[^A-Za-z0-9-]/gu, "")]] as const;
  const utf16 = (text: string): number[] => [...text].flatMap((char) => u16(char.charCodeAt(0)));
  let nameOffset = 0;
  const nameRecords: number[] = [];
  const nameStrings: number[] = [];
  for (const [id, text] of names) {
    const bytes = utf16(text);
    nameRecords.push(...u16(3, 1, 0x409, id, bytes.length, nameOffset));
    nameStrings.push(...bytes);
    nameOffset += bytes.length;
  }
  const tables: Record<string, number[]> = {
    "OS/2": [
      ...u16(4, 700, 400, 5, 0, 650, 700, 0, 140, 650, 700, 0, 480, 50, 250, 0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32(1, 0, 0, 0), 0x20, 0x20, 0x20, 0x20, ...u16(0x40, 0x20, 0x7e, 800, 0x10000 - 200, 0, 800, 200), ...u32(1, 0),
      ...u16(500, 700, 0, 0x20, 0),
    ],
    cmap: [...u16(0, 1, 3, 1), ...u32(12), ...u16(4, 32, 0, 4, 4, 1, 0, 0x7e, 0xffff, 0, 0x20, 0xffff, (1 - 0x20) & 0xffff, 1, 0, 0)],
    glyf: Array.from({ length: glyphs - 1 }, () => block).flat(),
    head: [...u32(0x10000, 0x10000, 0, 0x5f0f3cf5), ...u16(0x000b, 1000), ...u32(0, 0, 0, 0), ...u16(100, 0, 600, 700, 0, 8, 2, 1, 0)],
    hhea: [...u32(0x10000), ...u16(800, 0x10000 - 200, 0, 700, 0, 100, 600, 1, 0, 0, 0, 0, 0, 0, 0, glyphs)],
    hmtx: [...u16(700, 0), ...Array.from({ length: glyphs - 1 }, () => u16(700, 100)).flat()],
    loca: u32(0, ...Array.from({ length: glyphs }, (_, index) => index * block.length)),
    maxp: [...u32(0x10000), ...u16(glyphs, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)],
    name: [...u16(0, names.length, 6 + names.length * 12), ...nameRecords, ...nameStrings],
    post: [...u32(0x30000, 0), ...u16(0x10000 - 100, 50), ...u32(0, 0, 0, 0, 0)],
  };
  const tags = Object.keys(tables).sort();
  const checksum = (bytes: readonly number[]): number => {
    let sum = 0;
    for (let index = 0; index < bytes.length; index += 4) {
      sum = (sum + ((bytes[index]! << 24) | ((bytes[index + 1] ?? 0) << 16) | ((bytes[index + 2] ?? 0) << 8) | (bytes[index + 3] ?? 0))) >>> 0;
    }
    return sum;
  };
  const header = [...u32(0x10000), ...u16(tags.length, 128, 3, tags.length * 16 - 128)];
  const records: number[] = [];
  const body: number[] = [];
  let offset = header.length + tags.length * 16;
  let headOffset = 0;
  for (const tag of tags) {
    const data = tables[tag]!;
    if (tag === "head") headOffset = offset;
    records.push(...[...tag].map((char) => char.charCodeAt(0)), ...u32(checksum(data), offset, data.length));
    const padded = [...data, ...Array.from({ length: (4 - (data.length % 4)) % 4 }, () => 0)];
    body.push(...padded);
    offset += padded.length;
  }
  const font = Uint8Array.from([...header, ...records, ...body]);
  new DataView(font.buffer).setUint32(headOffset + 8, (0xb1b0afba - checksum([...font])) >>> 0);
  return `data:font/ttf;base64,${Buffer.from(font).toString("base64")}`;
}
