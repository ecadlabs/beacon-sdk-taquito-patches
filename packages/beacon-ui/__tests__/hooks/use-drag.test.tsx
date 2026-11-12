import { render, fireEvent } from '@testing-library/react'
import useDrag from '../../src/components/toast/hooks/useDrag'

describe('useDrag hook', () => {
  test('handles dragging events correctly', () => {
    const handler = vi.fn()

    const TestComponent = () => {
      const bindDrag = useDrag(handler)
      return <div data-testid="drag-element" {...bindDrag()} />
    }

    const { getByTestId } = render(<TestComponent />)
    const dragElement = getByTestId('drag-element')

    // Simulate mouse down event to start dragging
    fireEvent.mouseDown(dragElement, { clientX: 100, clientY: 100 })
    expect(handler).not.toHaveBeenCalled()

    // Simulate mouse move event
    fireEvent.mouseMove(document, { clientX: 150, clientY: 160 })
    expect(handler).toHaveBeenCalledWith({ offset: [50, 60] })

    // Simulate additional mouse move event
    fireEvent.mouseMove(document, { clientX: 200, clientY: 220 })
    expect(handler).toHaveBeenCalledWith({ offset: [100, 120] })

    // Simulate mouse up event to stop dragging
    fireEvent.mouseUp(document)

    // Verify no further calls occur after dragging has stopped
    fireEvent.mouseMove(document, { clientX: 300, clientY: 320 })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  test('ignores mousemove events when not dragging', () => {
    const handler = vi.fn()

    const TestComponent = () => {
      const bindDrag = useDrag(handler)
      return <div data-testid="drag-element" {...bindDrag()} />
    }

    render(<TestComponent />)

    // Mousemove without mousedown should not call handler
    fireEvent.mouseMove(document, { clientX: 150, clientY: 160 })
    expect(handler).not.toHaveBeenCalled()
  })

  test('clamps drag offsets to element bounding rect within viewport bounds so toast cannot be dragged off-screen', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 })
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 768 })

    const handler = vi.fn()

    const TestComponent = () => {
      const bindDrag = useDrag(handler)
      return <div data-testid="drag-element" {...bindDrag()} />
    }

    const { getByTestId } = render(<TestComponent />)
    const dragElement = getByTestId('drag-element')

    // Simulate a 460x60 toast anchored at top: 12px, right: 12px (left = 1024 - 12 - 460 = 552, right = 1012, top = 12, bottom = 72)
    vi.spyOn(dragElement, 'getBoundingClientRect').mockReturnValue({
      x: 552,
      y: 12,
      left: 552,
      top: 12,
      right: 1012,
      bottom: 72,
      width: 460,
      height: 60,
      toJSON: () => ({})
    })

    fireEvent.mouseDown(dragElement, { clientX: 600, clientY: 30 })

    // Drag far off-screen to the top-left: left edge cannot cross x=0 (minX = -552) and top edge cannot cross y=0 (minY = -12)
    fireEvent.mouseMove(document, { clientX: -5000, clientY: -5000 })
    const [clampedMinX, clampedMinY] = handler.mock.lastCall?.[0].offset ?? [0, 0]
    expect(clampedMinX).toBe(-552)
    expect(clampedMinY).toBe(-12)

    // Drag far off-screen to the bottom-right: right edge cannot cross x=1024 (maxX = +12) and bottom edge cannot cross y=768 (maxY = 768 - 72 = +696)
    fireEvent.mouseMove(document, { clientX: 5000, clientY: 5000 })
    const [clampedMaxX, clampedMaxY] = handler.mock.lastCall?.[0].offset ?? [0, 0]
    expect(clampedMaxX).toBe(12)
    expect(clampedMaxY).toBe(696)

    fireEvent.mouseUp(document)
  })
})
