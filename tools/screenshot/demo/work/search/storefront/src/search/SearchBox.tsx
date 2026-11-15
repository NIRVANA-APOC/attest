import { useMemo, useState } from 'react'
import { catalog } from '../catalog.ts'
import { searchCatalog } from '../api/search.ts'

/** Header search: filters the loaded catalog as you type, arrow keys and Escape included. */
export const SearchBox = () => {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => searchCatalog(catalog, query), [query])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(index => Math.min(results.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => Math.max(0, index - 1))
    } else if (event.key === 'Enter' && results[active] !== undefined) {
      window.location.assign(`/product/${results[active].id}`)
    } else if (event.key === 'Escape') {
      setQuery('')
      setActive(0)
    }
  }

  return (
    <div className="header-search" role="search">
      <input
        aria-label="Search products"
        placeholder="Search products"
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {query !== '' && (
        <ul className="header-search-results" aria-label="Suggestions">
          {results.length === 0 ? <li className="empty">No products match “{query}”.</li> : results.map((product, index) => (
            <li key={product.id} aria-selected={index === active}>
              <a href={`/product/${product.id}`}>{product.name}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
