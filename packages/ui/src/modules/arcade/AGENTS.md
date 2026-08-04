# Building games for the void arcade

Notes for whoever adds the next cabinet. Most of this was learned by getting it
wrong first and being corrected by someone who knows the original games, which
is the only reliable oracle for "does it feel right". Everything below cost
real time to discover.

---

## The contract

Adding a game is one file plus one line in `registry.ts`. That is the whole
cost, and it should stay that way.

```ts
export interface GameDef {
  id: string; name: string; year: string; glyph: string;
  blurb: string; controls: string[];
  width: number; height: number;   // your native resolution
  create(host: GameHost): Game;    // update(dt, pad) / draw(g)
}
```

The one thing you may share with other cabinets is `games/shared/pixel.ts`:
the run-length sprite blitter and the 3x5 font. Everything else — your art,
your rules, your simulation — stays in your own folder, so a cabinet is a
directory you can delete.

A `Game` gets a delta, a pad, and a 2D context already scaled to its own pixel
grid. **No DOM, no kernel, no settings, no audio routing, no canvas.** If you
find yourself wanting one of those, it belongs in the cabinet, not in the game.
That is what makes games portable and keeps anything that could misbehave
inside the shell in one place.

**You get these for free. Do not reimplement them:**

| the cabinet already does | so don't |
| --- | --- |
| integer letterboxing and scaling | scale anything yourself |
| the CRT (scanlines, grille, bloom, curvature, vignette) | build screen effects into your game |
| keyboard capture, scoped to focus | add key listeners |
| pause, mute, high scores, the frame loop | any of it |

The CRT one matters: a game that draws its own scanlines gets them *twice*.

---

## Physics: the five things that were wrong the first time

Joust shipped once feeling like a modern platformer wearing 1982's rules. Every
cause was a modern instinct applied without noticing. Check yourself against
all five.

### 1. Fixed timestep, drawn without interpolation

```ts
update(dt, pad) {
  this.acc += dt;
  let ticks = 0;
  while (this.acc >= TICK && ticks < MAX_TICKS) { this.acc -= TICK; ticks++; this.tick(pad); }
  if (ticks >= MAX_TICKS) this.acc = 0;   // drop the backlog, don't teleport
}
```

Running physics at the display's refresh rate produces motion that is smooth in
a way nothing from that era was, and smoothness is most of what reads as wrong.
30Hz, drawn straight, puts the chunk back. It also makes the sim deterministic
in the input sequence, which is what makes a test bot worth anything.

**The trap:** at 30Hz against a 60Hz display, half your frames run no tick, and
the cabinet clears its edge set every frame. Reading `pad.hit()` inside the tick
silently drops half your button presses and the game feels like it is ignoring
you. **Latch presses in `update`, consume them in `tick`.** The trap also runs
the other way: at 60Hz against a 120Hz panel, exactly the same thing happens.
Latch regardless of your tick rate.

**Fixed, yes. 30Hz, not necessarily.** Joust ticks at 30 because Williams'
motion has a chunk that a 60Hz sim smooths away. That reasoning does not
transfer automatically, and three of the four cabinets do not follow it:

- *Pac-Man* ticks at 60 because its speeds are **defined** as fractions of a
  pixel per 60Hz frame. Halving the rate does not add period texture, it
  rounds every entry in the speed table to something else and puts the ghosts
  on the wrong side of the player.
- *Galaga* ticks at 60 because its enemies fly along curves. At 30Hz a diver
  steps four pixels through the tightest part of its loop and the arc becomes
  a visible polygon.
- *Missile Command* ticks at 60 for the same reason: everything is a straight
  line at speed, and coarse sampling turns a trajectory into a dotted one.

The question to ask is *where does the quantisation in this game come from*. If
it comes from the clock, use a coarse clock. If it comes from a speed table or
a curve, a coarse clock only damages it. Either way, **write down which and
why**, next to the constant.

### 2. Quantise at the integration, never the stored velocity

```ts
r.x += quantize(r.vx) * dt;   // right
r.vx = quantize(r.vx);        // WRONG
```

Rounding the stored value throws the remainder away every tick, so any
acceleration smaller than half a quantum per tick is **annihilated rather than
merely reduced**. In Joust that silently set air steering to exactly zero, and
it took a measurement to notice. Real fixed point keeps the residue and steps
once it accumulates.

### 3. Momentum is the difficulty; the sprite is not

These are two separate things and conflating them is a bug in both directions.

- **Momentum should resist.** Turning against your own velocity should be
  *harder* than holding a line (a turn multiplier below 1, not above), and
  thrust into your own motion should brake rather than reverse.
- **The sprite should not.** It faces the stick **immediately**. Facing one way
  while still travelling the other is the entire look of these games.

Holding the sprite until velocity crosses zero reads as *unresponsive*, not as
heavy. Heavy is the goal; unresponsive is a bug, and a player spots it in
seconds.

### 4. Movement comes from the verb, not the stick

In Joust the wings supply both height and heading; holding a direction is a
nudge. Splitting them into two independent controls gives far too much
authority. Whatever your game's central verb is (flap, thrust, jump) it should
be doing most of the work.

### 5. On a grid, test the wall where you *leave*, not where you arrive

Pac-Man's mover was written the obvious way first: move, then check whether the
new tile is solid. It passed a typecheck, looked fine, and put Pac-Man inside a
wall eighteen seconds into the first bot run — an entity resting exactly on a
tile centre against a wall skipped the check entirely on the following tick and
stepped straight through.

Structure the loop around **centre crossings**: land exactly on each tile
centre in turn, make every decision there, and refuse to depart into a solid
tile. Then entering a wall is not a bug that has been fixed, it is a state the
loop cannot express — and it holds at any speed, which matters, because
returning eyes move at more than twice walking pace and a proximity-tolerance
version fails precisely there.

### 6. If the screen wraps, everything goes through `wrapDelta`

Steering, collision, drawing. Otherwise entities turn *away* from something
standing next to them through the seam.

---

## Enemies

### The stupidity goes in the choosing, not in the arriving

The biggest AI mistake made here: scattering the enemies' aim, letting them
commit blindly, and cutting their drive. That does not produce charming
incompetence, it produces enemies that **cannot reach you**, and a player who
knows the original notices at once.

A 1982 enemy converges on you perfectly well. What it does badly is *decide*:
it takes fights from a losing position, wanders when it loses track, and flies
into hazards. Put the incompetence there.

### Use the wrap instead of braking

The single change that made the flock read correctly:

```ts
if (want !== 0 && want * e.vx < 0 && Math.abs(e.vx) > WRAP_RATHER_THAN_TURN) {
  want = Math.sign(e.vx);   // keep going, come around the seam
}
```

It was also a bug fix. Traced tick by tick, an enemy would close to 15px, take
a fresh snapshot that landed *behind* itself, reverse into its own momentum,
and sail away. Forever. Continuing was both faster and the thing the original
does. Seam crossings went 17 to 41 per minute, mean speed 56 to 97px/s.

### Cadence, not dice

Drive enemy rhythm off a period, not a per-tick probability. The dice version
claimed 3.9 wingbeats/sec by arithmetic and delivered 1.8, and the gap was
never worth explaining. A period makes the number one you *set* rather than one
you measure and then argue with.

### Sharing movement code cuts both ways

Player and enemies going through one `move()` is right: it guarantees they obey
the same physics. But it means **tuning the player silently retunes the flock**.
Cutting air acceleration for player weight left enemies, who only flapped for
altitude, at half the player's speed. After any physics change, re-measure the
enemies.

---

## Measure, don't guess

The repo's habit of verifying simulations numerically applies double here,
because "feels right" is not directly checkable and the things that *are*
checkable are where being wrong is silent.

**Split the game in two.** Put every constant and every rule that is a pure
function in a `rules.ts`: combat resolution, scoring curves, wave structure,
level geometry, wrap maths. Those get asserted headlessly in `tools/smoke.mts`.
The part that needs a canvas stays in `index.ts` and gets a bot.

**Write a bot.** A stub 2D context (a `Proxy` returning no-ops) plus a scripted
input loop finds things play-testing does not:

- a player who could fly off the top of the screen and vanish: invisible,
  unreachable, unbeatable
- a grab that became mathematically unescapable after a cooldown change
- non-finite positions, entities leaving the playfield, throws in `draw()`

**Drive set pieces directly.** Do not wait for the bot to trigger your rare
mechanic; it will not. Poke the state, step, assert. Four minutes of bot play
never once constructed the pterodactyl.

**Watch your instrument.** A bot that reverses faster than a reversal takes
measures nothing; one that flaps blindly pins itself to the ceiling where
nothing can reach it. Both looked like game bugs and were not. Give the bot the
instincts a player acquires in a minute.

**Make your stub context answer chained calls.** A `Proxy` returning bare
no-ops is not enough. `createLinearGradient(...).addColorStop(...)` is an
ordinary thing to do in a draw path, and against a no-op stub it throws on the
gradient rather than on anything the test is about — which reads as the game
being broken. Return the proxy itself from every call. Joust failed the
"draws with no canvas" check on exactly this, and Joust was fine.

**Check whether you measured one game a hundred times.** These sims are
deterministic in the input sequence, which is the property that makes a bot
worth anything and also the one that will quietly hand you a hundred identical
runs. The tell is `max == median`. Vary the seed per run or you are reporting a
sample size of one with great confidence.

**Benchmark before you tune.** A handful of runs is noise: one sample said a
median wave was 33.5s and the next said 46.8s. Run 100+ full games. And measure
*two* bots, one that ignores the core mechanic and one that uses it. The gap
between them is whether your game is learnable. Joust: 12 waves cleared versus
132, an 11x payoff for grasping "get above them". That ratio is the number that
matters, not the absolute difficulty.

Measured the same way, on 120 seeded games per bot:

| cabinet | bot that understands it | bot that flails | gap |
| --- | --- | --- | --- |
| Pac-Man | 8,780 / 2 boards | 240 / 0 boards | 36x |
| Galaga | 54,160 / stage 12 | 4,500 / stage 1 | 12x |
| Missile Command | 17,975 / wave 8 | 425 / wave 2 | 42x |

**And drive the set pieces by hand anyway.** Four minutes of bot play never
once constructed the pterodactyl, and it never once got a Galaga fighter
captured either. Both mechanics were verified by poking the state directly —
put a boss in formation over the ship, step, assert the capture; then send the
carrying boss on a dive, shoot it, assert the dual fighter.

**Record the reasoning at the constant.** `PTERO_AFTER` carries the measurement
that produced it, so the next person re-measures instead of re-guessing, and it
needed retuning twice as the physics moved.

---

## Art

**Do not reproduce the original sprites.** Those bitmaps are a copyrighted
visual work. Draw original art of the same subject, and say so in the file so
nobody has to wonder later. This is not a limitation in practice: what you
actually need is the *read*, not the pixels.

**Silhouette over detail.** The Joust mount only started looking like a mount
when the neck became a distinct run climbing in single-pixel steps to a head
set forward and high. Without that diagonal it read as a duck. Ask what single
line tells the player which way this thing is pointing, and spend your pixels
there.

**Make the art and the rules agree by construction.** Combat compares the top
of the sprite, so the lance is drawn to row 0. No separate height field means
nothing to drift out of sync.

**String maps for fixed shapes, procedural for ranges.** One character per
pixel, run-length blitted, recoloured per enemy tier from one map. Anything
that animates through a range (wings, a beating creature) is cheaper and
smoother drawn from the phase than as hand-authored frames.

**Ship a bitmap font.** `fillText` at 3x renders anti-aliased glyphs over hard
pixels, and that mismatch is the single most obvious way a retro screen looks
wrong. A 3x5 font is about forty short strings.

**Black backgrounds.** A moving background behind hard sprites is something the
hardware could not do. Let the theme show as rim light on geometry instead.

**Check the level geometry against the real thing.** The Joust arena shipped
with nine platforms when it should have had six, no central island, and, by
accident, one lava pool instead of two, because laying the floor flush to both
edges joins the outer gaps through the wrap seam. Count things.

---

## Sound

- **Everything through `src/ui/blip.ts`.** Browsers cap AudioContexts and the
  failure is silent. CI greps for `new AudioContext`.
- **Check `host.muted()` before every sound**, and wrap playback in try/catch.
  Audio is a nicety and must never take a frame down.
- **Layer, don't beep.** A wingbeat is a feather snap *plus* the thump of the
  downstroke; one band alone reads as a click.
- **Pace footfalls by distance, not by a timer**, or the sound drifts against
  the stride.

---

## Shell rules that will bite you

- **No `localStorage` / `sessionStorage` / `indexedDB`.** State goes through
  `ctx.state`, which follows the account. CI greps for it, against
  comment-stripped source, so you may mention it in prose.
- **jsdom has no 2D context.** The smoke harness constructs games headlessly:
  `mountStage` returns early and `frame` never runs, so nothing may touch a
  canvas in a constructor. Guard `document.createElement("canvas")` and degrade
  rather than throw.
- **Never use `this` in a render path** that the kernel might call unbound.
- **Adding a module means three files**: `main.ts`, `tools/smoke.mts`, and
  `MODULE_COUNT`. The harness registers its own list and will report green
  while testing nothing if you forget, which has already happened once.
- **`noUnusedLocals` counts assignment as a write, not a read.** A variable you
  set and never read fails the build.

---

## The short version

Build the rules as pure functions and assert them. Build the feel by measuring
it, not by describing it. Put the enemy's stupidity in what it decides, never
in whether it can reach you. And when someone who has played the original says
it feels wrong, they are right. The useful question is *which specific thing*
they are reacting to, because it is always something concrete and it is usually
not the thing you would have guessed.
