import { z } from 'zod';

/** Lenient schema for the SceneSKU public pack. Unknown fields are ignored. */
const sourceImage = z.object({
  id: z.string(),
  index: z.number().int(),
  title: z.string().nullish(),
  image_url: z.url(),
  thumbnail_url: z.url().nullish(),
});

const sourceItem = z.object({
  id: z.string(),
  state: z.string(),
  visibility: z.string().nullish(),
  categories: z.array(z.object({ name: z.string(), slug: z.string() })).default([]),
  images: z.array(sourceImage).default([]),
  product_data: z.object({
    product_title: z.string().min(1),
    short_description: z.string().nullish(),
    long_description: z.string().nullish(),
    bullet_points: z.array(z.string()).nullish(),
    tags: z.array(z.string()).nullish(),
    price: z.union([z.string(), z.number()]),
    options: z
      .object({
        Color: z.array(z.string()).nullish(),
        Size: z.array(z.union([z.string(), z.number()])).nullish(),
      })
      .partial()
      .nullish(),
  }),
});

export const sourcePackSchema = z.object({ data: z.array(sourceItem) });

export type SourceItem = z.infer<typeof sourceItem>;
export type SourceImage = z.infer<typeof sourceImage>;

export async function fetchSourcePack(url: string): Promise<SourceItem[]> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'AVERO-catalog-importer/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`SKU API responded ${res.status} ${res.statusText}`);
  const parsed = sourcePackSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`SKU API payload did not match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data.data;
}
