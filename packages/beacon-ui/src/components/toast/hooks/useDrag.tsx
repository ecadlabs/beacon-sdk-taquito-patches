import { useEffect, useRef } from 'react'

const useDrag = (
  handler: (state: { offset: [number, number] }) => void,
  resetTrigger?: boolean
) => {
  const dragRef = useRef<{
    startX: number
    startY: number
    minX: number
    maxX: number
    minY: number
    maxY: number
    isDragging: boolean
  }>({
    startX: 0,
    startY: 0,
    minX: -Infinity,
    maxX: Infinity,
    minY: -Infinity,
    maxY: Infinity,
    isDragging: false
  })
  const positionRef = useRef<[number, number]>([0, 0])

  useEffect(() => {
    if (resetTrigger !== undefined) {
      positionRef.current = [0, 0]
    }
  }, [resetTrigger])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const currentOffset = positionRef.current
    dragRef.current.isDragging = true
    dragRef.current.startX = e.clientX - currentOffset[0]
    dragRef.current.startY = e.clientY - currentOffset[1]

    const target = e.currentTarget as HTMLElement | null
    const rect = target?.getBoundingClientRect?.()
    if (rect && (rect.width > 0 || rect.height > 0)) {
      const baseLeft = rect.left - currentOffset[0]
      const baseRight = rect.right - currentOffset[0]
      const baseTop = rect.top - currentOffset[1]
      const baseBottom = rect.bottom - currentOffset[1]

      dragRef.current.minX = -baseLeft
      dragRef.current.maxX = Math.max(-baseLeft, window.innerWidth - baseRight)
      dragRef.current.minY = -baseTop
      dragRef.current.maxY = Math.max(-baseTop, window.innerHeight - baseBottom)
    } else {
      dragRef.current.minX = -Infinity
      dragRef.current.maxX = Infinity
      dragRef.current.minY = -Infinity
      dragRef.current.maxY = Infinity
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (!dragRef.current.isDragging) return

    const rawX = e.clientX - dragRef.current.startX
    const rawY = e.clientY - dragRef.current.startY

    const newX = Math.min(dragRef.current.maxX, Math.max(dragRef.current.minX, rawX))
    const newY = Math.min(dragRef.current.maxY, Math.max(dragRef.current.minY, rawY))

    positionRef.current = [newX, newY]
    handler({ offset: [newX, newY] })
  }

  const handleMouseUp = () => {
    dragRef.current.isDragging = false
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
  }

  const bindDrag = () => ({ onMouseDown: handleMouseDown })

  return bindDrag
}

export default useDrag
