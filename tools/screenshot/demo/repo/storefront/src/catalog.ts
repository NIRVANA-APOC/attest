export type Product = {
  id: string
  name: string
  category: string
  priceCents: number
  color: string
}

/** The catalog ships whole: category pages filter it on the client. */
export const catalog: Product[] = [
  { id: 'p-01', name: 'Linen shirt', category: 'shirts', priceCents: 7900, color: 'sand' },
  { id: 'p-02', name: 'Wide trousers', category: 'trousers', priceCents: 11900, color: 'charcoal' },
  { id: 'p-03', name: 'Wool overshirt', category: 'shirts', priceCents: 21500, color: 'moss' },
  { id: 'p-04', name: 'Canvas tote', category: 'bags', priceCents: 4500, color: 'ink' },
  { id: 'p-05', name: 'Merino scarf', category: 'accessories', priceCents: 6500, color: 'rust' },
  { id: 'p-06', name: 'Leather belt', category: 'accessories', priceCents: 8900, color: 'chestnut' },
]
