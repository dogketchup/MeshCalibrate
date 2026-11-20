// ArUco bit patterns for the rig geometry. DOM-free (runs under node for tests).
//
// aruco-marker generates the original ArUco dictionary, which is OpenCV's
// DICT_ARUCO_ORIGINAL: 5x5 data bits inside a one-cell black border, ids 0..1023.
import { arucoMarkerMatrix } from 'aruco-marker';

export const DICTIONARY = 'DICT_ARUCO_ORIGINAL';
export const MARKER_CELLS = 7; // 5 data bits + 1 border cell on each side
export const MAX_ID = 1023;

/**
 * The marker as a 7x7 grid of cells, row-major, row 0 = the marker's top edge
 * and column 0 = its left edge as printed. true = black.
 *
 * arucoMarkerMatrix(id) is indexed [column][row] with 1 = white: its own SVG
 * writer draws a white square at x = n + 1, y = i + 1 for matrix[n][i] === 1.
 */
export function markerCells(id) {
  if (!Number.isInteger(id) || id < 0 || id > MAX_ID) {
    throw new RangeError(`marker id ${id} is outside ${DICTIONARY} (0..${MAX_ID})`);
  }
  const m = arucoMarkerMatrix(id);
  const cells = [];
  for (let r = 0; r < MARKER_CELLS; r++) {
    const row = [];
    for (let c = 0; c < MARKER_CELLS; c++) {
      const border = r === 0 || c === 0 || r === MARKER_CELLS - 1 || c === MARKER_CELLS - 1;
      row.push(border ? true : m[c - 1][r - 1] !== 1);
    }
    cells.push(row);
  }
  return cells;
}
