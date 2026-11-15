import { catalog, type Product } from '../catalog.ts'

const card = (product: Product) => (
  <a className="product-card" href={`/product/${product.id}`} data-color={product.color}>
    <span className="product-name">{product.name}</span>
    <span className="product-price">€{(product.priceCents / 100).toFixed(2)}</span>
  </a>
)

export const CatalogPage = ({ category }: { category?: string }) => {
  const products = category === undefined ? catalog : catalog.filter(product => product.category === category)

  return (
    <section className="product-grid" aria-label="Products">
      {products.map(card)}
    </section>
  )
}
