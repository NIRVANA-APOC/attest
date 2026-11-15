import { CartButton } from './CartButton.tsx'
import { Logo } from './Logo.tsx'
import { SearchBox } from '../search/SearchBox.tsx'

export const Header = () => (
  <header className="app-header">
    <Logo />
    <nav className="app-nav" aria-label="Catalog">
      <a href="/new">New</a>
      <a href="/catalog">Catalog</a>
      <a href="/sale">Sale</a>
    </nav>
    <SearchBox />
    <CartButton />
  </header>
)
