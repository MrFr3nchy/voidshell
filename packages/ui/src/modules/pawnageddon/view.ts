/**
 * The board, drawn.
 *
 * A canvas through `ctx.stage`, with the panels around it as ordinary DOM. The
 * split is deliberate: the board is a grid of sprites that wants pixel control
 * and one hit-test, while gold, hands and the log are text and buttons that
 * want to be selectable, scrollable and reachable by keyboard. Drawing the HUD
 * into the canvas would have cost all of that to gain nothing.
 *
 * The original game's React components are not ported. They were a different
 * presentation layer for the same state, and voidshell modules render DOM and
 * canvas directly.
 */

import type { KernelContext } from "../../kernel/types";
import { findKing, getPiece, isWhitePiece } from "./board";
import {
  DARK_SQUARE,
  HIGHLIGHT_CAP,
  HIGHLIGHT_MOVE,
  HIGHLIGHT_SEL,
  LIGHT_SQUARE,
  CHECK_TINT,
  FILES,
  SQUARES,
} from "./constants";
import type { PawnGame } from "./game";
import { CELL_H, CELL_W, cellFor, loadSheet, type SpriteSheet } from "./sprites";
import { getUltimate } from "./ultimates";
import type { Piece } from "./types";

/** A sweep left by an ultimate, faded out over its lifetime. */
interface Sweep {
  squares: [number, number][];
  age: number;
  ttl: number;
  color: string;
}

export interface BoardView {
  dispose: () => void;
  /** Squares the board occupies, for the HUD to stay in step. */
  repaint: () => void;
}

const LETTER: Record<string, string> = {
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};

export function mountBoard(
  host: HTMLElement,
  ctx: KernelContext,
  game: PawnGame,
  onSquare: (col: number, row: number) => void
): BoardView {
  let sheet: SpriteSheet = { image: null, ready: false };
  const sweeps: Sweep[] = [];

  // Geometry, recomputed on resize so the hit-test and the drawing can never
  // disagree about where a square is.
  let size = 0;
  let originX = 0;
  let originY = 0;

  const layout = (w: number, h: number) => {
    size = Math.max(8, Math.floor(Math.min(w, h) / SQUARES));
    originX = Math.floor((w - size * SQUARES) / 2);
    originY = Math.floor((h - size * SQUARES) / 2);
  };

  const dispose = ctx.stage.mount(host, {
    className: "pg-canvas",
    layout: (stage) => layout(stage.w, stage.h),
    frame: (stage, dt) => {
      for (let i = sweeps.length - 1; i >= 0; i--) {
        sweeps[i].age += dt;
        if (sweeps[i].age >= sweeps[i].ttl) sweeps.splice(i, 1);
      }
      draw(stage.g, stage.w, stage.h);
    },
  });

  sheet = loadSheet(() => {
    /* the frame loop picks it up on its own */
  });

  const pal = ctx.stage.palette();

  function draw(g: CanvasRenderingContext2D, w: number, h: number): void {
    if (size === 0) layout(w, h);
    g.clearRect(0, 0, w, h);

    const check = game.inCheck && !game.gameOver;
    const kingSquare = check ? findKing(game.board, game.whiteToMove) : null;
    const highlights = new Set(game.validMoves);
    const sel = game.selected;

    for (let row = 0; row < SQUARES; row++) {
      for (let col = 0; col < SQUARES; col++) {
        const x = originX + col * size;
        const y = originY + row * size;
        const light = (row + col) % 2 === 0;
        g.fillStyle = light ? LIGHT_SQUARE : DARK_SQUARE;
        g.fillRect(x, y, size, size);

        const piece = getPiece(game.board, col, row);

        if (sel && sel[0] === col && sel[1] === row) {
          g.fillStyle = ctx.stage.withAlpha(HIGHLIGHT_SEL, 0.55);
          g.fillRect(x, y, size, size);
        } else if (highlights.has(`${col},${row}`)) {
          // A capture reads differently from a quiet move, which is most of
          // what makes a board scannable at a glance.
          const capture = piece !== " ";
          g.fillStyle = ctx.stage.withAlpha(capture ? HIGHLIGHT_CAP : HIGHLIGHT_MOVE, 0.45);
          if (capture) {
            g.fillRect(x, y, size, size);
          } else {
            g.beginPath();
            g.arc(x + size / 2, y + size / 2, size * 0.16, 0, Math.PI * 2);
            g.fill();
          }
        }

        if (kingSquare && kingSquare[0] === col && kingSquare[1] === row) {
          g.fillStyle = ctx.stage.withAlpha(CHECK_TINT, 0.5);
          g.fillRect(x, y, size, size);
        }

        drawSquareState(g, col, row, x, y);
        if (piece !== " ") drawPiece(g, piece, x, y);
        drawGear(g, col, row, x, y);
      }
    }

    drawSweeps(g);
    drawCoordinates(g);
  }

  /** Hazards and mutations sit under the piece, as a tinted border. */
  function drawSquareState(
    g: CanvasRenderingContext2D,
    col: number,
    row: number,
    x: number,
    y: number
  ): void {
    const hazard = game.chaos.getHazardAt(col, row);
    const mutation = game.chaos.getMutationAt(col, row);
    if (hazard) {
      g.strokeStyle = ctx.stage.withAlpha(pal.ember, 0.85);
      g.lineWidth = Math.max(2, size * 0.06);
      g.strokeRect(x + g.lineWidth / 2, y + g.lineWidth / 2, size - g.lineWidth, size - g.lineWidth);
    }
    if (mutation) {
      g.strokeStyle = ctx.stage.withAlpha(
        mutation.type === "freeze" ? pal.cyan : pal.magenta,
        0.9
      );
      g.lineWidth = Math.max(2, size * 0.05);
      const inset = g.lineWidth * 1.6;
      g.strokeRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
    }
  }

  function drawPiece(g: CanvasRenderingContext2D, piece: Piece, x: number, y: number): void {
    const cell = cellFor(piece);
    if (sheet.ready && sheet.image && cell) {
      // Drawn at the cell's own 96x128 aspect and anchored to the bottom of
      // the square, which is what makes a tall piece stand on its square
      // rather than hover over the middle of it.
      //
      // The height is exactly one square and not a little more. Overhanging
      // the square looks better in the middle of the board and clips both
      // back ranks against the edge of the canvas, which is where the pieces
      // that overhang most happen to start the game. The cell already carries
      // its own headroom, so a piece still reaches ~95% of the square.
      const drawH = size;
      const drawW = (drawH * CELL_W) / CELL_H;
      g.drawImage(
        sheet.image,
        cell.sx,
        cell.sy,
        CELL_W,
        CELL_H,
        x + (size - drawW) / 2,
        y + size - drawH,
        drawW,
        drawH
      );
      return;
    }
    // No sheet: letters. Ugly, still playable.
    const white = isWhitePiece(piece);
    g.fillStyle = white ? "#ffffff" : "#101014";
    g.strokeStyle = white ? "#101014" : "#ffffff";
    g.lineWidth = Math.max(1, size * 0.02);
    g.font = `${Math.floor(size * 0.72)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const glyph = LETTER[piece.toLowerCase()] ?? "?";
    g.fillText(glyph, x + size / 2, y + size / 2);
    g.strokeText(glyph, x + size / 2, y + size / 2);
  }

  /** A small corner pip for a piece carrying gear. */
  function drawGear(
    g: CanvasRenderingContext2D,
    col: number,
    row: number,
    x: number,
    y: number
  ): void {
    const weapon = game.getWeaponAt(col, row);
    const shield = game.getShieldAt(col, row);
    if (!weapon && !shield) return;
    const r = Math.max(3, size * 0.1);
    if (weapon) {
      g.fillStyle = ctx.stage.withAlpha(pal.ember, 0.95);
      g.beginPath();
      g.arc(x + size - r - 2, y + r + 2, r, 0, Math.PI * 2);
      g.fill();
    }
    if (shield) {
      g.fillStyle = ctx.stage.withAlpha(pal.cyan, 0.95);
      g.beginPath();
      g.arc(x + r + 2, y + r + 2, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  function drawSweeps(g: CanvasRenderingContext2D): void {
    for (const sweep of sweeps) {
      const alpha = 1 - sweep.age / sweep.ttl;
      g.fillStyle = ctx.stage.withAlpha(sweep.color, alpha * 0.6);
      for (const [col, row] of sweep.squares) {
        g.fillRect(originX + col * size, originY + row * size, size, size);
      }
    }
  }

  /**
   * File letters along the bottom, rank numbers up the right.
   *
   * Each label is drawn in the *other* square colour to the square it sits on,
   * which is the only way it stays readable: a fixed colour is invisible on
   * half of them, and both edges alternate.
   */
  function drawCoordinates(g: CanvasRenderingContext2D): void {
    const pad = Math.max(2, Math.round(size * 0.04));
    g.font = `600 ${Math.max(8, Math.floor(size * 0.2))}px system-ui, sans-serif`;
    g.textBaseline = "alphabetic";

    const ink = (col: number, row: number) =>
      (row + col) % 2 === 0 ? DARK_SQUARE : LIGHT_SQUARE;

    for (let i = 0; i < SQUARES; i++) {
      g.fillStyle = ink(i, SQUARES - 1);
      g.textAlign = "left";
      g.fillText(FILES[i], originX + i * size + pad, originY + SQUARES * size - pad);

      g.fillStyle = ink(SQUARES - 1, i);
      g.textAlign = "right";
      g.fillText(
        String(SQUARES - i),
        originX + SQUARES * size - pad,
        originY + i * size + Math.max(9, size * 0.24)
      );
    }
  }

  /** Canvas coordinates to a square, or null outside the board. */
  const hitTest = (clientX: number, clientY: number, canvas: HTMLElement): [number, number] | null => {
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left - originX) / size);
    const row = Math.floor((clientY - rect.top - originY) / size);
    if (col < 0 || col >= SQUARES || row < 0 || row >= SQUARES) return null;
    return [col, row];
  };

  const onClick = (e: MouseEvent) => {
    const canvas = host.querySelector("canvas");
    if (!canvas) return;
    const hit = hitTest(e.clientX, e.clientY, canvas);
    if (hit) onSquare(hit[0], hit[1]);
  };
  host.addEventListener("click", onClick);

  // An ultimate's sweep is the one thing worth animating: it is the moment the
  // game stops being chess, and a board that simply blinks pieces out of
  // existence reads as a bug.
  const offUltimate = game.on("ultimate", ({ result, row, col }) => {
    const piece = getPiece(game.board, col, row);
    const ult = getUltimate(piece);
    sweeps.push({
      squares: result.path,
      age: 0,
      ttl: 0.55,
      color: ult ? pal.ember : pal.magenta,
    });
  });

  return {
    dispose: () => {
      offUltimate();
      host.removeEventListener("click", onClick);
      dispose();
    },
    repaint: () => {
      /* the frame loop repaints continuously; kept so callers need not care */
    },
  };
}
