import { createContext, useContext } from 'react'

export interface GraphContextValue {
  onHover: (id: string | null) => void
  onToggleCollapse: (id: string) => void
  onSelect: (id: string) => void
  onPin: (id: string | null) => void
}

const Ctx = createContext<GraphContextValue>({
  onHover: () => {},
  onToggleCollapse: () => {},
  onSelect: () => {},
  onPin: () => {},
})

export const GraphContextProvider = Ctx.Provider

export function useGraphContext(): GraphContextValue {
  return useContext(Ctx)
}
