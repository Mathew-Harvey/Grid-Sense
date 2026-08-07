// Labels drawn onto a live chart, pointing at the things a newcomer needs
// named: this line, this band, this cluster of dots.
//
// A legend explains a chart in the abstract; these explain the chart the
// reader is actually looking at, anchored to its real pixels. The positions
// come from the chart's own coordinate transforms at the moment the overlay
// opens, and are recomputed while it stays open, so the labels ride along as
// the replay scrolls underneath them.
//
// The overlay is DOM rather than canvas so the text wraps, scales with the
// user's font settings, and can be dismissed with the same tap that opened it.

/**
 * @param {HTMLElement} host chart container; becomes the overlay's frame
 * @param {() => Array<{x: number, y: number, text: string, align?: string}>|null} computeItems
 *        returns pixel positions within the host, or null when the chart has
 *        nothing to point at yet
 * @returns {{open: () => void, close: () => void, toggle: () => void,
 *            reposition: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function createCallouts(host, computeItems) {
  let layer = null;

  function close() {
    layer?.remove();
    layer = null;
  }

  function render() {
    const items = computeItems();
    if (!items || items.length === 0) { close(); return; }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'callout-layer';
      // Dismiss on tap anywhere over the chart: the overlay answered a
      // question, it must never get in the way of the next one.
      layer.addEventListener('click', close);
      host.appendChild(layer);
    }
    const width = host.clientWidth;
    layer.innerHTML = items.map((it) => {
      const align = it.align ?? 'left';
      // A right-aligned label is anchored by its right edge, because an
      // absolutely positioned box only gets the room between `left` and the
      // container's edge — beside the chart's right margin that is a few
      // pixels, and the text folds into a one-word-per-line column.
      const anchor = align === 'right'
        ? `right:${Math.round(width - it.x)}px`
        : `left:${Math.round(it.x)}px`;
      return `<div class="callout ${align}" style="${anchor};top:${Math.round(it.y)}px">` +
        `<span class="callout-dot"></span><span class="callout-text">${it.text}</span></div>`;
    }).join('');
  }

  return {
    open: render,
    close,
    toggle() { layer ? close() : render(); },
    reposition() { if (layer) render(); },
    isOpen: () => layer !== null,
    destroy: close,
  };
}
