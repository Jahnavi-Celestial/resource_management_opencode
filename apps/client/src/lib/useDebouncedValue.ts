import { useEffect, useState } from 'react'

/**
 * Search and filter inputs push a new GraphQL query on every keystroke unless
 * something waits for a pause in typing. Shared by `DataTable`'s search box and
 * its filter bar so both behave the same way (and both are still instant in a
 * test that passes a delay of 0).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value)
      return undefined
    }
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
