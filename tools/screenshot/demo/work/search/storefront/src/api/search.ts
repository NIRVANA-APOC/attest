import type { Product } from '../catalog.ts'

/** Case- and accent-insensitive match over the catalog the storefront already loads. */
export const searchCatalog = (products: Product[], query: string): Product[] => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []

  return products.filter(product => `${product.name} ${product.category}`.toLowerCase().includes(needle))
}
