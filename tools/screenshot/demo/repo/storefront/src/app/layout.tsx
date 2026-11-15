import type { ReactNode } from 'react'
import { Header } from '../components/Header.tsx'

export const Layout = ({ children }: { children: ReactNode }) => (
  <div className="app">
    <Header />
    <main className="page">{children}</main>
  </div>
)
