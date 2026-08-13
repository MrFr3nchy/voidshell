/**
 * Pawnageddon's own rules, asserted directly.
 *
 * The smoke harness launches the app and proves it renders. It cannot see any
 * of what is below: a shield that announces itself and then lets the piece die,
 * gear that changes sides when its owner is taken, a hazard nothing ever
 * triggers on. Every one of those is a rule the original got wrong, and not one
 * of them throws or looks wrong on screen — which is exactly why they are here
 * rather than left to play-testing.
 *
 * Perft lives in its own harness (`tools/pawnageddon-perft.mts`) because it is
 * slow enough to deserve its own tier.
 */

import { PawnGame } from "../packages/ui/src/modules/pawnageddon/game";
import { applyMove, fromFen, legalMovesFor, outcome } from "../packages/ui/src/modules/pawnageddon/position";
import { allLegalMoves, legalTargets } from "../packages/ui/src/modules/pawnageddon/moves";
import { CARDS } from "../packages/ui/src/modules/pawnageddon/cards";
import { EVENTS } from "../packages/ui/src/modules/pawnageddon/events";
import { SHIELDS, WEAPONS } from "../packages/ui/src/modules/pawnageddon/equipment";
import { ULTIMATES } from "../packages/ui/src/modules/pawnageddon/ultimates";
import { cellFor, CELL_H, CELL_W } from "../packages/ui/src/modules/pawnageddon/sprites";
import { countPieces } from "../packages/ui/src/modules/pawnageddon/board";
import type { Move, Piece, Rng } from "../packages/ui/src/modules/pawnageddon/types";

type Check = (label: string, ok: boolean) => void;

/**
 * A seeded generator, so a failing bot run can be replayed.
 *
 * mulberry32 — small, fast, and good enough for shuffling a deck. The point is
 * reproducibility, not statistical quality.
 */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Put a piece on an otherwise-empty board. */
function place(game: PawnGame, at: [number, number], piece: Piece): void {
  game.board[at[1]][at[0]] = piece;
}

function clearBoard(game: PawnGame): void {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) game.board[r][c] = " ";
}

export function pawnageddonChecks(check: Check): void {
  // ── Content ──

  check("every card has at least one effect", CARDS.every((c) => c.effects.length > 0));
  check("every event has at least one effect", EVENTS.every((e) => e.effects.length > 0));
  check("card ids are unique", new Set(CARDS.map((c) => c.id)).size === CARDS.length);
  check("event ids are unique", new Set(EVENTS.map((e) => e.id)).size === EVENTS.length);
  check(
    "every phase 1-5 has cards to draw",
    [1, 2, 3, 4, 5].every((p) => CARDS.some((c) => c.phase === p))
  );
  check(
    "the starting deck is drawable — phase 1-3 cards exist",
    CARDS.filter((c) => c.phase <= 3).length >= 13
  );
  check("all six pieces have an ultimate", Object.keys(ULTIMATES).length === 6);
  check(
    "every ultimate costs chaos",
    Object.values(ULTIMATES).every((u) => u.chaosCost > 0)
  );
  check(
    "every equippable costs gold and has uses",
    [...Object.values(WEAPONS), ...Object.values(SHIELDS)].every((i) => i.cost > 0 && i.uses > 0)
  );

  // ── Sprite sheet geometry ──

  // The sheet is 6x2 cells of 96x128. A wrong row here silently swaps the two
  // colours, which is the kind of thing that looks deliberate on a screenshot.
  check("white pawn is the first cell", (() => {
    const c = cellFor("p");
    return c?.sx === 0 && c?.sy === 0;
  })());
  check("black pawn sits on the second row", cellFor("P")?.sy === CELL_H);
  check("the king is the last column", cellFor("k")?.sx === 5 * CELL_W);
  check("an empty square has no cell", cellFor(" ") === null);
  check(
    "every piece maps to a distinct cell",
    new Set(
      (["p", "n", "b", "r", "q", "k", "P", "N", "B", "R", "Q", "K"] as Piece[]).map((p) => {
        const c = cellFor(p);
        return `${c?.sx},${c?.sy}`;
      })
    ).size === 12
  );

  // ── Chess rules the game leans on ──

  check("the opening position has twenty moves", allLegalMoves(
    new PawnGame().board,
    true,
    { white_kingside: true, white_queenside: true, black_kingside: true, black_queenside: true },
    null
  ).length === 20);

  check("fool's mate is mate", (() => {
    const pos = fromFen("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq -");
    return outcome(pos) === "checkmate";
  })());

  check("a stalemate is not a mate", (() => {
    const pos = fromFen("7k/5Q2/6K1/8/8/8/8/8 b - -");
    return outcome(pos) === "stalemate";
  })());

  check("a promotion offers four choices, not one", (() => {
    const pos = fromFen("8/P6k/8/8/8/8/8/K7 w - -");
    const promos = legalMovesFor(pos).filter((m) => m.promoteTo);
    return promos.length === 4;
  })());

  check("castling moves the rook too", (() => {
    const pos = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq -");
    const castle = legalMovesFor(pos).find((m) => m.fromCol === 4 && m.toCol === 6);
    if (!castle) return false;
    const after = applyMove(pos, castle).next;
    return after.board[7][5] === "r" && after.board[7][7] === " ";
  })());

  check("capturing a rook on its corner ends that castling right", (() => {
    // Black bishop takes the h1 rook; White's kingside right must go with it.
    const pos = fromFen("4k3/8/8/8/8/8/6b1/R3K2R b KQ -");
    const grab = legalMovesFor(pos).find((m) => m.toCol === 7 && m.toRow === 7);
    if (!grab) return false;
    return applyMove(pos, grab).next.rights.white_kingside === false;
  })());

  check("en passant only fires for a pawn", (() => {
    // The position the perft run singled out: a knight landing on the en
    // passant square must not remove the pawn standing beside it.
    const pos = fromFen("r3k2r/Pp1p1ppp/1b3nbN/nPp5/BBPNP3/q7/Pp1P2PP/R2Q1RK1 w kq c6");
    const knight = legalMovesFor(pos).find(
      (m) => m.fromCol === 3 && m.fromRow === 4 && m.toCol === 2 && m.toRow === 2
    );
    if (!knight) return false;
    const after = applyMove(pos, knight).next;
    return after.board[3][2] === "P";
  })());

  // ── The rules the original got wrong ──

  check("a shield saves the piece it is on", (() => {
    const game = new PawnGame(seeded(1));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");   // white rook
    place(game, [3, 4], "R");   // black rook, about to be taken
    game.pieceShields.set("3,4", { id: "iron", uses: 1 });
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 3, toRow: 4 });
    // The defender lives, the attacker did not move, and the shield is spent.
    return (
      game.board[4][3] === "R" &&
      game.board[4][0] === "r" &&
      game.pieceShields.has("3,4") === false
    );
  })());

  check("and the block does not also count as a capture", (() => {
    const game = new PawnGame(seeded(1));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");
    place(game, [3, 4], "R");
    game.pieceShields.set("3,4", { id: "iron", uses: 1 });
    const goldBefore = game.whiteGold;
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 3, toRow: 4 });
    return game.whiteGold === goldBefore && game.capturedBlack.length === 0;
  })());

  check("gear does not survive its owner", (() => {
    const game = new PawnGame(seeded(2));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");
    place(game, [3, 4], "R");
    // The defender carries a weapon; the attacker carries nothing. After the
    // capture the square must be clean, or the attacker inherits it.
    game.pieceWeapons.set("3,4", { id: "sword", uses: 1 });
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 3, toRow: 4 });
    return game.board[4][3] === "r" && game.getWeaponAt(3, 4) === null;
  })());

  check("a piece takes its own gear with it", (() => {
    const game = new PawnGame(seeded(3));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");
    game.pieceWeapons.set("0,4", { id: "bomb", uses: 1 });
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 0, toRow: 3 });
    return game.getWeaponAt(0, 4) === null && game.getWeaponAt(0, 3)?.id === "bomb";
  })());

  check("a bomb takes the neighbours with it", (() => {
    const game = new PawnGame(seeded(4));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [0, 0], "K");
    place(game, [0, 4], "r");
    place(game, [3, 4], "R");   // the target
    place(game, [3, 3], "P");   // adjacent, should go up with it
    place(game, [2, 5], "P");   // adjacent diagonally
    game.pieceWeapons.set("0,4", { id: "bomb", uses: 1 });
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 3, toRow: 4 });
    return game.board[3][3] === " " && game.board[5][2] === " ";
  })());

  check("the poison hazard actually triggers", (() => {
    const game = new PawnGame(seeded(5));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");
    game.chaos.placeHazard(0, 3, "plague", 4);
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 0, toRow: 3 });
    // The rook stepped onto plague and did not survive it.
    return game.board[3][0] === " ";
  })());

  check("a weapon is spent by using it", (() => {
    const game = new PawnGame(seeded(6));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");
    place(game, [3, 4], "R");
    game.pieceWeapons.set("0,4", { id: "sword", uses: 1 });
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 3, toRow: 4 });
    return game.getWeaponAt(3, 4) === null;
  })());

  check("a sword pays out on the capture it is spent on", (() => {
    const game = new PawnGame(seeded(7));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");
    place(game, [3, 4], "R");   // a rook, worth 5
    game.pieceWeapons.set("0,4", { id: "sword", uses: 1 });
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 3, toRow: 4 });
    return game.whiteGold === 5 + 3;
  })());

  // ── Ultimates ──

  check("an ultimate needs the chaos to pay for it", (() => {
    const game = new PawnGame(seeded(8));
    const before = countPieces(game.board);
    // No chaos banked, so nothing should happen.
    const result = game.useUltimate(0, 6);
    return result === null && countPieces(game.board) === before;
  })());

  check("a rook's ultimate clears its rank and file", (() => {
    const game = new PawnGame(seeded(9));
    game.whiteChaos = 100;
    const result = game.useUltimate(0, 7);
    if (!result) return false;
    // Everything on row 7 and column 0 is gone, the rook itself excepted.
    for (let c = 1; c < 8; c++) if (game.board[7][c] !== " ") return false;
    for (let r = 0; r < 7; r++) if (game.board[r][0] !== " ") return false;
    return game.board[7][0] === "r";
  })());

  check("an ultimate hands the turn over", (() => {
    const game = new PawnGame(seeded(10));
    game.whiteChaos = 100;
    game.useUltimate(0, 7);
    return game.whiteToMove === false;
  })());

  check("and so does a blocked capture", (() => {
    const game = new PawnGame(seeded(15));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [4, 0], "K");
    place(game, [0, 4], "r");
    place(game, [3, 4], "R");
    game.pieceShields.set("3,4", { id: "iron", uses: 1 });
    game.playMove({ fromCol: 0, fromRow: 4, toCol: 3, toRow: 4 });
    return game.whiteToMove === false;
  })());

  // ── The bot ──

  /**
   * Play whole games at random and assert the invariants a player would
   * notice being broken: the board stays legal, both kings stay on it while
   * the game is live, and the thing terminates.
   *
   * Random play is the right instrument here precisely because the chaos deck
   * is what breaks the board — a scripted game would walk one line through a
   * system whose whole point is that it does something different every time.
   */
  let crashes = 0;
  let finished = 0;
  let longest = 0;
  let chaosSeen = 0;
  let boardsWithoutKing = 0;
  const MAX_PLIES = 400;

  for (let seed = 1; seed <= 60; seed++) {
    const rng = seeded(seed * 7919);
    const game = new PawnGame(rng);
    let phases = 1;
    game.on("phaseUp", ({ phase }) => {
      phases = phase;
    });
    try {
      game.start();
      let plies = 0;
      while (!game.gameOver && plies < MAX_PLIES) {
        const moves: Move[] = legalMovesFor(game.position);
        if (!moves.length) break;

        // A player would sometimes spend chaos and sometimes play a card; a bot
        // that only ever pushes wood never reaches the code that matters.
        if (rng() < 0.06 && game.currentChaos >= 40) {
          const own: [number, number][] = [];
          for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++) {
              const p = game.board[r][c];
              if (p !== " " && (p === p.toLowerCase()) === game.whiteToMove) own.push([c, r]);
            }
          if (own.length) {
            const [c, r] = own[Math.floor(rng() * own.length)];
            if (game.useUltimate(c, r)) {
              plies++;
              continue;
            }
          }
        }
        if (rng() < 0.15 && game.currentHand.length) {
          game.playCard(game.currentHand[0].id);
          if (game.gameOver) break;
        }

        const move = moves[Math.floor(rng() * moves.length)];
        game.playMove(move);
        plies++;

        // Invariants, every ply.
        if (!Number.isFinite(game.whiteGold) || !Number.isFinite(game.blackGold)) {
          throw new Error("non-finite gold");
        }
        if (game.whiteChaos < 0 || game.blackChaos < 0) throw new Error("negative chaos");
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            const p = game.board[r][c];
            if (p !== " " && !"pnbrqkPNBRQK".includes(p)) throw new Error(`bad square ${p}`);
          }
        }
        // Chaos can genuinely eat a king — a nova does not care whose piece it
        // is — so this is counted rather than asserted. It must not *crash*.
        const kings = game.board.flat().filter((p) => p.toLowerCase() === "k").length;
        if (kings < 2) boardsWithoutKing++;
      }
      longest = Math.max(longest, plies);
      if (game.gameOver || plies < MAX_PLIES) finished++;
      chaosSeen = Math.max(chaosSeen, phases);
    } catch (err) {
      crashes++;
      if (crashes === 1) {
        console.log(`      first bot crash on seed ${seed}: ${(err as Error).message}`);
      }
    }
  }

  check(`60 random games ran without crashing (${crashes} crashed)`, crashes === 0);
  check(`and every one terminated (${finished}/60, longest ${longest} plies)`, finished === 60);
  check(`the deck escalated past phase 1 (reached ${chaosSeen})`, chaosSeen > 1);

  // The selection path the UI drives, exercised once headlessly: clicking a
  // piece must offer exactly the moves the generator says it has.
  check("clicking a piece offers its legal moves", (() => {
    const game = new PawnGame(seeded(11));
    game.start();
    game.clickSquare(4, 6);
    const expected = legalTargets(game.board, 4, 6, game.position.rights, game.position.ep);
    return game.validMoves.size === expected.size && expected.size === 2;
  })());

  check("clicking an empty square clears the selection", (() => {
    const game = new PawnGame(seeded(12));
    game.start();
    game.clickSquare(4, 6);
    game.clickSquare(0, 3);
    return game.selected === null && game.validMoves.size === 0;
  })());

  check("a pawn reaching the last rank asks before it promotes", (() => {
    const game = new PawnGame(seeded(13));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [7, 0], "K");
    place(game, [0, 1], "p");
    let asked = false;
    game.on("promotionNeeded", () => {
      asked = true;
    });
    game.clickSquare(0, 1);
    game.clickSquare(0, 0);
    // The move is held, not played, until a choice comes back.
    return asked && game.board[0][0] === " " && game.pendingPromotion !== null;
  })());

  check("and the choice is what lands on the board", (() => {
    const game = new PawnGame(seeded(14));
    clearBoard(game);
    place(game, [4, 7], "k");
    place(game, [7, 0], "K");
    place(game, [0, 1], "p");
    game.clickSquare(0, 1);
    game.clickSquare(0, 0);
    game.choosePromotion("n");
    return game.board[0][0] === "n";
  })());
}
