import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Viewport } from "../store/useCompareStore";

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;
const WHEEL_SENSITIVITY = 0.0018;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export interface PanZoomApi {
  /**
   * Callback ref, not a plain ref object: consumers may mount the container on a
   * later render than the hook call (the lightbox renders nothing until a target
   * is picked), and the wheel listener has to follow the element.
   */
  containerRef: (node: HTMLDivElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Scale so the image fits inside the container, then centre it. */
  fit: (imageWidth: number, imageHeight: number) => void;
  /** Snap to 1 device pixel per image pixel, keeping the container centre fixed. */
  actualSize: () => void;
  zoomBy: (factor: number) => void;
}

/**
 * Wheel-to-zoom (anchored at the cursor) and drag-to-pan over a container.
 *
 * The wheel listener is registered natively because React routes `onWheel`
 * through a passive root listener, where `preventDefault` is a no-op.
 */
export function usePanZoom(viewport: Viewport, onChange: (viewport: Viewport) => void): PanZoomApi {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const setContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setElement(node);
  }, []);
  const viewportRef = useRef(viewport);
  const changeRef = useRef(onChange);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(
    null,
  );

  viewportRef.current = viewport;
  changeRef.current = onChange;

  const zoomAtPoint = useCallback((offsetX: number, offsetY: number, factor: number) => {
    const current = viewportRef.current;
    const next = clampScale(current.scale * factor);
    const ratio = next / current.scale;
    changeRef.current({
      scale: next,
      x: offsetX - (offsetX - current.x) * ratio,
      y: offsetY - (offsetY - current.y) * ratio,
    });
  }, []);

  useEffect(() => {
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAtPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * WHEEL_SENSITIVITY),
      );
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [element, zoomAtPoint]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Capturing the pointer would retarget the following click away from any control
    // layered over the image, so leave those alone and don't start a drag.
    if ((event.target as Element).closest?.("button, input, select, a")) return;
    const current = viewportRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: current.x,
      originY: current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    changeRef.current({
      scale: viewportRef.current.scale,
      x: drag.originX + (event.clientX - drag.x),
      y: drag.originY + (event.clientY - drag.y),
    });
  }, []);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const fit = useCallback((imageWidth: number, imageHeight: number) => {
    const element = containerRef.current;
    if (!element || imageWidth <= 0 || imageHeight <= 0) return;
    const { clientWidth, clientHeight } = element;
    if (clientWidth === 0 || clientHeight === 0) return;
    const scale = clampScale(
      Math.min(clientWidth / imageWidth, clientHeight / imageHeight) * 0.98,
    );
    changeRef.current({
      scale,
      x: (clientWidth - imageWidth * scale) / 2,
      y: (clientHeight - imageHeight * scale) / 2,
    });
  }, []);

  const actualSize = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    zoomAtPoint(element.clientWidth / 2, element.clientHeight / 2, 1 / viewportRef.current.scale);
  }, [zoomAtPoint]);

  const zoomBy = useCallback(
    (factor: number) => {
      const element = containerRef.current;
      if (!element) return;
      zoomAtPoint(element.clientWidth / 2, element.clientHeight / 2, factor);
    },
    [zoomAtPoint],
  );

  return {
    containerRef: setContainer,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fit,
    actualSize,
    zoomBy,
  };
}
