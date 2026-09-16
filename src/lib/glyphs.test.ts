/**
 * The glyphs drive a RECORDING context rather than a browser, so every path decision is
 * checkable here and a dropped `stroke()` - the failure that renders nothing while the code
 * still "draws" - is caught by a unit test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { drawGlyph, GLYPHS, type GlyphContext, type GlyphName } from "./glyphs.ts";

type Call = { op: string; args: number[] };

function recorder(): { ctx: GlyphContext; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args: args.filter((a) => typeof a === "number") as number[] });
  };
  const ctx = {
    beginPath: rec("beginPath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"),
    bezierCurveTo: rec("bezierCurveTo"), quadraticCurveTo: rec("quadraticCurveTo"),
    arc: rec("arc"), stroke: rec("stroke"), fill: rec("fill"),
    strokeRect: rec("strokeRect"), fillRect: rec("fillRect"),
  } as GlyphContext;
  return { ctx, calls };
}

const draw = (name: GlyphName) => {
  const { ctx, calls } = recorder();
  drawGlyph(ctx, name);
  return calls;
};

test("every glyph actually puts ink down", () => {
  // The failure this exists for: a path built and never stroked or filled draws NOTHING while
  // the function still ran and threw nothing. A blank 16px icon in a heading is invisible in
  // review, which is how all five went missing in the first place.
  for (const name of GLYPHS) {
    const calls = draw(name);
    const inked = calls.filter((c) => ["stroke", "fill", "strokeRect", "fillRect"].includes(c.op));
    assert.ok(inked.length > 0, `${name} built a path and never painted it`);
  }
});

test("every path is begun before it is drawn into", () => {
  // A lineTo or moveTo before any beginPath appends to whatever the previous glyph left open,
  // which is how one icon bleeds into the next on a shared context.
  for (const name of GLYPHS) {
    let begun = false;
    for (const c of draw(name)) {
      if (c.op === "beginPath") begun = true;
      else if (["moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo", "arc"].includes(c.op))
        assert.ok(begun, `${name} drew ${c.op} before any beginPath`);
    }
  }
});

test("every coordinate sits inside the preview's 16 by 16 grid", () => {
  // The grid is the contract with the CSS: the caller scales by width/16, so a coordinate
  // outside it is clipped rather than drawn small.
  for (const name of GLYPHS) {
    for (const c of draw(name)) {
      if (c.op === "arc") continue;               // radius and angles are not coordinates
      for (const n of c.args)
        assert.ok(n >= 0 && n <= 16, `${name} has ${n} outside the 16 grid via ${c.op}`);
    }
  }
});

test("the drips glyph is the preview's drop, arc and all", () => {
  const calls = draw("drips");
  assert.deepEqual(calls.map((c) => c.op),
    ["beginPath", "moveTo", "bezierCurveTo", "arc", "bezierCurveTo", "stroke"]);
  assert.deepEqual(calls[1].args, [8, 2.5]);
  assert.deepEqual(calls[2].args, [8, 5, 3.5, 8, 3.5, 10.5]);
  assert.deepEqual(calls[3].args.slice(0, 3), [8, 10.5, 4.5]);
});

test("the reserve glyph is a tank with a fill line, outline then contents", () => {
  const calls = draw("reserve");
  assert.deepEqual(calls.map((c) => c.op), ["strokeRect", "fillRect"]);
  assert.deepEqual(calls[0].args, [3.5, 2.5, 9, 11]);
  // The fill starts BELOW the top of the box: a tank drawn full would say the reserve is full.
  assert.deepEqual(calls[1].args, [3.5, 8.5, 9, 5]);
  assert.ok(calls[1].args[1] > calls[0].args[1], "the fill must start below the tank's top");
});

test("the network glyph draws three nodes and three edges", () => {
  const calls = draw("network");
  assert.equal(calls.filter((c) => c.op === "arc").length, 3);
  assert.equal(calls.filter((c) => c.op === "fill").length, 3);
  assert.equal(calls.filter((c) => c.op === "stroke").length, 3);
});

test("the miner and sends glyphs each stroke twice, so neither is half a mark", () => {
  assert.equal(draw("miner").filter((c) => c.op === "stroke").length, 2);
  assert.equal(draw("sends").filter((c) => c.op === "stroke").length, 2);
});

test("an unknown name draws nothing rather than throwing", () => {
  const { ctx, calls } = recorder();
  drawGlyph(ctx, "nope" as GlyphName);
  assert.equal(calls.length, 0);
});
